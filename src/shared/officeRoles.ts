// Portado de agentvivekkumar/dontbemichael (Vivek Kumar, MIT).
/**
 * Each Office character's job — the same in every business type, the way it was
 * in the show (owner's rule, 2026-09-23).
 *
 * A business type chooses WHICH characters are on its team and how each job
 * reads for that trade (a restaurant's Oscar watches food cost; a CPA's watches
 * retainers). It never changes WHAT the job is: Oscar is always finance, Dwight
 * always sales. `office-pack-fixtures.test.cjs` holds every shipped pack to this
 * map, so a pack can't quietly give a character a different job again.
 *
 * Michael is not here: he is the office manager on every team, not a pack role.
 */

export const OFFICE_ROLES = {
  oscar: { role: 'Finance', folder: 'Finance' },
  dwight: { role: 'Sales Director', folder: 'Sales' },
  kelly: { role: 'Customer Support', folder: 'Support' },
  pam: { role: 'Executive Admin', folder: 'Admin' },
  ryan: { role: 'Marketing', folder: 'Marketing' },
  sadiq: { role: 'IT Security', folder: 'Security' },
  toby: { role: 'HR Manager', folder: 'HR' },
  nick: { role: 'IT Engineer', folder: 'IT' },
  creed: { role: 'Quality Control', folder: 'Quality' },
  meredith: { role: 'Supply Chain', folder: 'Supply Chain' },
  darryl: { role: 'Inventory & Shipping', folder: 'Inventory' }
} as const;

export type OfficeRoleCharacter = keyof typeof OFFICE_ROLES;
