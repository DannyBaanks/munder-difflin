#!/usr/bin/env node
/**
 * Office Bridge MCP v1 — Server
 *
 * A local-first MCP server that lets ChatGPT/Codex submit work to Michael
 * (the orchestrator in Munder Difflin), observe its lifecycle, add context,
 * request cancellation, and inspect office state.
 *
 * Protocol: office-bridge@1
 * Transport: stdio (JSON-RPC 2.0)
 * Security: local only; no network listener
 *
 * Usage:
 *   node server.js
 *
 * Environment:
 *   HIVE_ROOT  — path to the hive directory (required)
 *   AGENT_ID   — this agent's id (default: 'office-bridge')
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { HiveAdapter } from './hiveAdapter.js';

// ---------------------------------------------------------------------------
// Protocol version
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = 'office-bridge@1';
const SERVER_NAME = 'office-bridge';
const SERVER_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Initialize adapter
// ---------------------------------------------------------------------------

const adapter = new HiveAdapter();

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  {
    capabilities: {
      tools: {}
    }
  }
);

// -- List tools ------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'compose_submit',
      description:
        'Submit a compose (instruction) to Michael for decomposition and assignment. ' +
        'Returns task_id, message_id, status, and receipt. The compose is addressed to ' +
        'Michael; the caller cannot name a worker directly.',
      inputSchema: {
        type: 'object',
        properties: {
          compose: {
            type: 'string',
            description: 'Human-readable instruction for Michael'
          },
          title: {
            type: 'string',
            description: 'Optional short title for the task'
          },
          priority: {
            type: 'number',
            description: 'Task priority (1=highest, 10=lowest). Default: 5'
          },
          constraints: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional constraints for the task'
          },
          attachments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                content: { type: 'string' }
              }
            },
            description: 'Optional file attachments'
          },
          idempotency_key: {
            type: 'string',
            description: 'Optional key to prevent duplicate composes on retry'
          }
        },
        required: ['compose']
      }
    },
    {
      name: 'task_get',
      description:
        'Get the current status and details of a task. Returns normalized status, ' +
        'title, owner, child task summary, blocked reason, and receipts. Secrets ' +
        'and unrelated agent memory are excluded.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'The task ID to query'
          }
        },
        required: ['task_id']
      }
    },
    {
      name: 'task_message',
      description:
        'Add a message to a task thread. The message is delivered to Michael, ' +
        'who decides whether to relay, revise, or hold it.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'The task ID to message on'
          },
          message: {
            type: 'string',
            description: 'The message content'
          }
        },
        required: ['task_id', 'message']
      }
    },
    {
      name: 'task_cancel',
      description:
        'Request cancellation of a task. This asks the office to stop safely; ' +
        'it is not a process-kill escape hatch. Michael and the router handle ' +
        'cancellation according to current leases and Stop-hook semantics.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'The task ID to cancel'
          },
          reason: {
            type: 'string',
            description: 'Reason for cancellation'
          }
        },
        required: ['task_id', 'reason']
      }
    },
    {
      name: 'office_status',
      description:
        'Get the current office status: availability, Michael state, roster summary, ' +
        'task counts, blocked tasks, capabilities, and breaker state. No secrets, ' +
        'terminal bytes, or free-form prompt dumps.',
      inputSchema: {
        type: 'object',
        properties: {
          detail: {
            type: 'string',
            enum: ['minimal', 'full'],
            description: 'Detail level (default: minimal)'
          }
        }
      }
    }
  ]
}));

// -- Call tool -------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'compose_submit': {
        const result = await adapter.composeSubmit({
          compose: (args?.compose as string) || '',
          title: args?.title as string | undefined,
          priority: args?.priority as number | undefined,
          constraints: args?.constraints as string[] | undefined,
          attachments: args?.attachments as
            | { name: string; content: string }[]
            | undefined,
          idempotency_key: args?.idempotency_key as string | undefined
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  protocol: PROTOCOL_VERSION,
                  ...result
                },
                null,
                2
              )
            }
          ]
        };
      }

      case 'task_get': {
        const result = await adapter.taskGet({
          task_id: (args?.task_id as string) || ''
        });
        if (!result) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    protocol: PROTOCOL_VERSION,
                    error: 'task_not_found',
                    task_id: args?.task_id
                  },
                  null,
                  2
                )
              }
            ],
            isError: true
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  protocol: PROTOCOL_VERSION,
                  ...result
                },
                null,
                2
              )
            }
          ]
        };
      }

      case 'task_message': {
        const result = await adapter.taskMessage({
          task_id: (args?.task_id as string) || '',
          message: (args?.message as string) || ''
        });
        if (!result) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    protocol: PROTOCOL_VERSION,
                    error: 'task_not_found',
                    task_id: args?.task_id
                  },
                  null,
                  2
                )
              }
            ],
            isError: true
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  protocol: PROTOCOL_VERSION,
                  ...result
                },
                null,
                2
              )
            }
          ]
        };
      }

      case 'task_cancel': {
        const result = await adapter.taskCancel({
          task_id: (args?.task_id as string) || '',
          reason: (args?.reason as string) || ''
        });
        if (!result) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    protocol: PROTOCOL_VERSION,
                    error: 'task_not_found',
                    task_id: args?.task_id
                  },
                  null,
                  2
                )
              }
            ],
            isError: true
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  protocol: PROTOCOL_VERSION,
                  ...result
                },
                null,
                2
              )
            }
          ]
        };
      }

      case 'office_status': {
        const result = await adapter.officeStatus();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  protocol: PROTOCOL_VERSION,
                  ...result
                },
                null,
                2
              )
            }
          ]
        };
      }

      default:
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  protocol: PROTOCOL_VERSION,
                  error: 'unknown_tool',
                  message: `Unknown tool: ${name}`
                },
                null,
                2
              )
            }
          ],
          isError: true
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              protocol: PROTOCOL_VERSION,
              error: 'internal_error',
              message: error instanceof Error ? error.message : String(error)
            },
            null,
            2
          )
        }
      ],
      isError: true
    };
  }
});

// -- Start -----------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[office-bridge] MCP server started (protocol: ${PROTOCOL_VERSION})`);
}

main().catch((error) => {
  console.error('[office-bridge] Fatal error:', error);
  process.exit(1);
});
