'use strict';

/**
 * A Hugging Face cache that split an .onnx from its external weights across
 * blob directories made onnxruntime 1.30 refuse the model ("External data path
 * escapes model directory"), so every `mempalace mine` failed. The heal puts
 * the pair back in one real directory without touching anything else.
 * Built exactly like huggingface_hub 1.32 lays it out: snapshot symlink →
 * repo blob symlink → shared sharded blob.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { healSplitOnnxPairs, hfHubCacheDir } = loadTs('src/main/hfCacheHeal.ts');
const POSIX_LINKS = { skip: process.platform === 'win32' ? 'symlinks need privileges on Windows runners' : false };

function cache({ split = true } = {}) {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-heal-'));
  const put = (shard, sha, body) => {
    fs.mkdirSync(path.join(hub, 'blobs', shard), { recursive: true });
    fs.writeFileSync(path.join(hub, 'blobs', shard, sha), body);
  };
  put('6a', '6aonnx', 'GRAPH');
  put(split ? '2d' : '6a', '2ddata', 'WEIGHTS');
  const repo = path.join(hub, 'models--onnx-community--embeddinggemma-300m-ONNX');
  fs.mkdirSync(path.join(repo, 'blobs'), { recursive: true });
  fs.symlinkSync(path.join('..', '..', 'blobs', '6a', '6aonnx'), path.join(repo, 'blobs', 'r-onnx'));
  fs.symlinkSync(path.join('..', '..', 'blobs', split ? '2d' : '6a', '2ddata'), path.join(repo, 'blobs', 'r-data'));
  const onnx = path.join(repo, 'snapshots', 'rev1', 'onnx');
  fs.mkdirSync(onnx, { recursive: true });
  fs.symlinkSync(path.join('..', '..', '..', 'blobs', 'r-onnx'), path.join(onnx, 'model_quantized.onnx'));
  fs.symlinkSync(path.join('..', '..', '..', 'blobs', 'r-data'), path.join(onnx, 'model_quantized.onnx_data'));
  fs.symlinkSync(path.join('..', '..', '..', 'blobs', 'r-onnx'), path.join(onnx, 'unrelated.json'));
  return { hub, onnx };
}

test('a split .onnx pair ends up in one real directory, same bytes, and it stays that way', POSIX_LINKS, () => {
  const { hub, onnx } = cache();
  const model = path.join(onnx, 'model_quantized.onnx');
  const data = path.join(onnx, 'model_quantized.onnx_data');
  assert.notEqual(path.dirname(fs.realpathSync(model)), path.dirname(fs.realpathSync(data)), 'the fixture reproduces the split');

  const r = healSplitOnnxPairs(hub);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.healed.sort(), [model, data].sort());
  assert.equal(path.dirname(fs.realpathSync(model)), path.dirname(fs.realpathSync(data)));
  assert.equal(fs.readFileSync(model, 'utf8'), 'GRAPH');
  assert.equal(fs.readFileSync(data, 'utf8'), 'WEIGHTS');
  // hardlinks, not copies: the shared blob is the same inode
  assert.equal(fs.statSync(data).ino, fs.statSync(path.join(hub, 'blobs', '2d', '2ddata')).ino);
  assert.ok(fs.lstatSync(path.join(onnx, 'unrelated.json')).isSymbolicLink(), 'nothing but the pair is touched');

  assert.deepEqual(healSplitOnnxPairs(hub), { healed: [], errors: [] }, 'idempotent');
});

test('a pair that already shares a directory is left alone', POSIX_LINKS, () => {
  const { hub, onnx } = cache({ split: false });
  assert.deepEqual(healSplitOnnxPairs(hub), { healed: [], errors: [] });
  assert.ok(fs.lstatSync(path.join(onnx, 'model_quantized.onnx')).isSymbolicLink());
});

test('no cache, or an empty one, is a no-op', () => {
  assert.deepEqual(healSplitOnnxPairs(path.join(os.tmpdir(), 'no-such-hf-cache-xyz')), { healed: [], errors: [] });
  assert.deepEqual(healSplitOnnxPairs(fs.mkdtempSync(path.join(os.tmpdir(), 'hf-empty-'))), { healed: [], errors: [] });
});

test('the cache location follows huggingface_hub\'s own precedence', () => {
  assert.equal(hfHubCacheDir({ HF_HUB_CACHE: '/x/hub', HF_HOME: '/h' }, '/home/u'), '/x/hub');
  assert.equal(hfHubCacheDir({ HF_HOME: '/h' }, '/home/u'), path.join('/h', 'hub'));
  assert.equal(hfHubCacheDir({ XDG_CACHE_HOME: '/c' }, '/home/u'), path.join('/c', 'huggingface', 'hub'));
  assert.equal(hfHubCacheDir({}, '/home/u'), path.join('/home/u', '.cache', 'huggingface', 'hub'));
});
