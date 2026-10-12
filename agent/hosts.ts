/**
 * Where model-written code may send: the hosts a person or the deployment
 * named, and nowhere else.
 *
 * `use_network` is a verb, so on its own "may call the network" means "may
 * call anything" — and exfiltration needs no write capability, only a URL with
 * something in it. `sandbox.run` takes `hosts` for that, checked by the engine
 * on every request and every redirect hop. This module decides the list.
 *
 * The rule is about *who wrote the name*, not about the name. A host becomes
 * reachable when it appears in text only a trusted party writes: the person's
 * own prompts, what they said while a run worked and the note on a decision,
 * their instructions, the deployment's instructions, and a skill's `hosts:`
 * line. A fetched page, a document, a tool result or the model's own prose can
 * name any host it likes and reaches none of them, which is the property the
 * list exists for: untrusted text cannot choose where private data goes.
 *
 * Read from the person's words rather than decided by the model, because the
 * model is the party being steered. And no model provider by default: `run_js`
 * holds no `read_secrets`, so it cannot call one with the person's key, and
 * with a key of its own a provider's file store is a way out like any other.
 *
 * Apart from `main.ts` for the reason `protocol.ts` gives — a root script
 * cannot `export`. Covered by `hosts.test.ts`.
 */

/**
 * How many hosts one sub-execution is given. The engine names the whole list
 * in every refusal, and that refusal is resent on every turn after it.
 */
export const MAX_HOSTS = 64;

/** A host after a scheme: a name, an IPv4 address, or a bracketed IPv6 one. */
const URL_HOST =
  /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/?#@]*@)?(\[[0-9a-f:.]+\]|[^\s/?#:\]["'<>),;]+)/gi;

/**
 * A bare domain in prose: two or more labels ending in a letters-only TLD, so
 * `docs.rs` and `yr.no` count and `e.g.` and `3.14` do not. It also counts
 * `main.ts`, which costs nothing: a host the person typed is one they could
 * have asked for.
 */
const BARE_HOST =
  /(^|[^a-z0-9.-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})(?![a-z0-9-])/gi;

/**
 * The hosts a piece of trusted text names, lower-cased, in order of first
 * appearance.
 *
 * `example.com` brings `www.example.com` with it and the other way round,
 * since a site that redirects between the two is the commonest reason a named
 * host would otherwise fail on the second hop. Nothing wider than that: a
 * subdomain is often someone else's (`*.github.io`), so `*.` is never
 * inferred.
 */
export function hostsNamedIn(text: string): string[] {
  const found: string[] = [];
  const add = (raw: string) => {
    const host = raw.toLowerCase().replace(/\.$/, "");
    if (!host) return;
    for (const variant of withWww(host)) {
      if (found.indexOf(variant) === -1) found.push(variant);
    }
  };
  for (const match of String(text ?? "").matchAll(URL_HOST)) add(match[1]);
  for (const match of String(text ?? "").matchAll(BARE_HOST)) add(match[2]);
  return found;
}

function withWww(host: string): string[] {
  if (host.indexOf("[") === 0 || /^[0-9.]+$/.test(host)) return [host];
  if (host.indexOf("www.") === 0) {
    const bare = host.slice(4);
    return bare.indexOf(".") === -1 ? [host] : [host, bare];
  }
  return host.indexOf(".") === -1 ? [host] : [host, "www." + host];
}

/**
 * A skill's `hosts:` line, comma- or space-separated. Taken as written rather
 * than found in prose, so `*.example.com` is allowed here and only here: the
 * line is deployment-authored, and `write_skill` cannot put one in.
 */
export function declaredHosts(line: string): string[] {
  const hosts: string[] = [];
  for (const part of String(line ?? "").split(/[\s,]+/)) {
    const host = part.trim().toLowerCase();
    if (!/^(\*\.)?[a-z0-9.-]+$/.test(host) || host.indexOf(".") === -1) {
      continue;
    }
    if (hosts.indexOf(host) === -1) hosts.push(host);
  }
  return hosts;
}

/**
 * Whether `pattern` permits `host`: the engine's rule, for narrowing a list
 * to the calling turn's own scope before asking. A wildcard does not match
 * its bare parent.
 */
export function patternPermits(pattern: string, host: string): boolean {
  if (pattern.indexOf("*.") !== 0) return pattern === host;
  const suffix = pattern.slice(2);
  return (
    host.length > suffix.length + 1 &&
    host.slice(-suffix.length) === suffix &&
    host[host.length - suffix.length - 1] === "."
  );
}

/**
 * The list to pass as `hosts`: the trusted sources in order of precedence —
 * the latest of the person's words first, so a cap drops the oldest — kept
 * to what the calling turn may itself reach.
 *
 * `held` is `sandbox.hosts()`: `null` for anywhere, otherwise a list. Asking
 * for a host outside it makes `sandbox.run` throw, and a turn that cannot
 * reach a host is not helped by its code being refused the whole run.
 */
export function allowedHosts(
  sources: string[][],
  held: string[] | null,
): string[] {
  const hosts: string[] = [];
  for (const source of sources) {
    for (const host of source) {
      if (hosts.length >= MAX_HOSTS) return hosts;
      if (hosts.indexOf(host) !== -1) continue;
      if (held !== null && !coveredBy(held, host)) continue;
      hosts.push(host);
    }
  }
  return hosts;
}

function coveredBy(held: string[], host: string): boolean {
  if (host.indexOf("*.") !== 0) {
    return held.some((pattern) => patternPermits(pattern, host));
  }
  const suffix = host.slice(2);
  return held.some(
    (pattern) =>
      pattern === host ||
      (pattern.indexOf("*.") === 0 &&
        (pattern.slice(2) === suffix || patternPermits(pattern, suffix))),
  );
}

/** Whether a sub-execution's output carries the engine's host refusal. */
export function refusedAHost(text: string): boolean {
  return String(text ?? "").indexOf("This execution may not reach '") !== -1;
}
