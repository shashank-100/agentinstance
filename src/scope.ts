// Whose object is this?
//
// Durable Objects are addressed by name: `idFromName("reviewer")` returns the
// same object to everyone who asks. That is exactly right for one person and
// wrong for two — two people who both call an agent `reviewer` do not get two
// agents with a visibility bug between them, they get *one object*, sharing its
// memory, its container and its conversation.
//
// No `WHERE ownerId = ?` fixes that, because the collision happens before any
// query runs. So the owner goes in the address, and isolation holds by
// construction: two people address different objects, and a query that forgets
// its filter cannot leak anything because there is nothing of anyone else's in
// the object to leak.

/**
 * The separator between an owner and a name.
 *
 * `/` because it cannot appear in a GitHub login and reads as a path. A name
 * containing one would let somebody address another person's object by typing
 * it, so `scoped` rejects that rather than trusting the caller.
 */
const SEP = "/";

/**
 * The deployment's own namespace, for everything that predates sign-in.
 *
 * A deployment that has been running has agents, tasks and keys already
 * addressed without an owner. Rather than migrate them — which would mean
 * copying Durable Object state that cannot be copied — unowned requests keep
 * resolving to exactly the objects they always did.
 */
export const DEPLOYMENT = "~";

/**
 * An object's full name, given who it belongs to.
 *
 * `owner` is a GitHub login, or `DEPLOYMENT` for a request with no signed-in
 * person. The result is what goes to `idFromName`.
 */
export function scoped(owner: string, name: string): string {
  if (name.includes(SEP)) {
    // A name is user input — an agent id from a URL. Allowing a separator in it
    // would let `alice/reviewer` be typed by anyone and resolve to Alice's
    // agent, which is the whole thing this file exists to prevent.
    throw new Error(`'${name}' cannot contain ${SEP}`);
  }
  return owner === DEPLOYMENT ? name : `${owner}${SEP}${name}`;
}

/**
 * The owner and bare name inside a scoped one.
 *
 * Needed where a scoped name travels and has to be read back — an agent knows
 * its own full name and has to work out which fleet is its own.
 */
export function unscope(full: string): { owner: string; name: string } {
  const i = full.indexOf(SEP);
  if (i === -1) return { owner: DEPLOYMENT, name: full };
  return { owner: full.slice(0, i), name: full.slice(i + 1) };
}

/**
 * The names of the shared objects belonging to one owner.
 *
 * The fleet and registry used to be single objects called `"global"`. Per
 * owner, they are one board and one agent list each — which is what makes two
 * people's work genuinely separate rather than interleaved behind a filter.
 *
 * `DEPLOYMENT` still resolves to `"global"` so an existing deployment's board
 * and registry are the same objects they were before any of this.
 */
export const fleetName = (owner: string): string =>
  owner === DEPLOYMENT ? "global" : `fleet${SEP}${owner}`;

export const registryName = (owner: string): string =>
  owner === DEPLOYMENT ? "global" : `registry${SEP}${owner}`;
