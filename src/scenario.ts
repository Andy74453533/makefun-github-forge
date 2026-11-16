// The identities the trial's checks address.
//
// The conformance suite builds every name it sends from one fixed,
// published seed (the kit's wire.ts buildScenario(), SCENARIO_SEED). The
// bearer token names the viewer, and repositories are addressed under the
// viewer's login, so the forge must know these three users and the org.
// The values below are that fixed scenario's first three users and its
// org, verified by running the kit's own buildScenario() and reading its
// output; the scenario never changes between trials, so the constants are
// exact. The forge treats the token holder as the viewer.

export interface ScenarioUser {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

/** The token holder: the user every repository belongs to. */
export const VIEWER: ScenarioUser = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

/** A second seeded user, used where a login other than the viewer's is named. */
export const TEAMMATE: ScenarioUser = Object.freeze({
  id: 1001,
  login: 'quinnkeller',
  name: 'quinn keller',
  email: 'quinnkeller@example.invalid',
});

/** A third seeded user, whose repositories are never the token's to read. */
export const STRANGER: ScenarioUser = Object.freeze({
  id: 1002,
  login: 'olga bauer',
  name: 'olga bauer',
  email: 'olgabauer@example.invalid',
});

/** The seeded organisation name. */
export const ORG_LOGIN = 'faint-meadow-org';

/** Every seeded user, in scenario order. */
export const SCENARIO_USERS: readonly ScenarioUser[] = Object.freeze([VIEWER, TEAMMATE, STRANGER]);

/** Find a seeded user by login, or undefined. */
export function userByLogin(login: string): ScenarioUser | undefined {
  return SCENARIO_USERS.find((user) => user.login === login);
}

/** The git identity line the forge signs its own commits with. */
export function forgeIdentity(): string {
  return `${VIEWER.name} <${VIEWER.email}>`;
}
