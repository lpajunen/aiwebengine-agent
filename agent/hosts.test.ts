/**
 * Where model-written code may send, as assertions. Each case names what a
 * wrong answer would let through or break.
 */

import {
  MAX_HOSTS,
  allowedHosts,
  declaredHosts,
  hostsNamedIn,
  patternPermits,
  refusedAHost,
} from "./hosts.ts";

describe("the hosts a person's words name", () => {
  test("a URL names its host", () => {
    expect(hostsNamedIn("summarise https://news.example.org/a?b=1")).toEqual([
      "news.example.org",
      "www.news.example.org",
    ]);
  });

  test("a bare domain counts, as people write them", () => {
    expect(hostsNamedIn("what is the weather on yr.no today")).toEqual([
      "yr.no",
      "www.yr.no",
    ]);
  });

  test("www and the bare name come together, for the redirect between them", () => {
    expect(hostsNamedIn("www.example.com")).toEqual([
      "www.example.com",
      "example.com",
    ]);
  });

  test("punctuation around a name is not part of it", () => {
    expect(hostsNamedIn("see example.com, or (https://docs.rs).")).toEqual([
      "docs.rs",
      "www.docs.rs",
      "example.com",
      "www.example.com",
    ]);
  });

  test("an abbreviation or a number is not a host", () => {
    expect(hostsNamedIn("e.g. 3.14 and i.e. nothing")).toEqual([]);
  });

  test("a URL's credentials and port are not its host", () => {
    expect(hostsNamedIn("http://me:pw@api.example.com:8080/x")).toEqual([
      "api.example.com",
      "www.api.example.com",
    ]);
  });

  test("an IP address is named only by a URL, and without a www twin", () => {
    expect(hostsNamedIn("http://203.0.113.7/status")).toEqual(["203.0.113.7"]);
  });

  test("a subdomain is never inferred, since it is often someone else's", () => {
    for (const host of hostsNamedIn("github.io")) {
      expect(host.indexOf("*")).toBe(-1);
    }
  });

  test("case does not make a second host", () => {
    expect(hostsNamedIn("Example.COM and example.com")).toEqual([
      "example.com",
      "www.example.com",
    ]);
  });
});

describe("a skill's hosts line", () => {
  test("takes a list, wildcards included", () => {
    expect(declaredHosts("api.github.com, *.githubusercontent.com")).toEqual([
      "api.github.com",
      "*.githubusercontent.com",
    ]);
  });

  test("drops what is not a host rather than widening to it", () => {
    expect(declaredHosts("* localhost https://x.com *.com.evil/")).toEqual([]);
  });
});

describe("the engine's matching rule", () => {
  test("a wildcard matches subdomains and not its parent", () => {
    expect(patternPermits("*.example.com", "api.example.com")).toBe(true);
    expect(patternPermits("*.example.com", "example.com")).toBe(false);
  });

  test("a lookalike suffix is not a subdomain", () => {
    expect(patternPermits("*.example.com", "evilexample.com")).toBe(false);
  });
});

describe("the list a sub-execution is given", () => {
  test("is the union of its sources, without repeats", () => {
    expect(
      allowedHosts(
        [
          ["a.com", "b.com"],
          ["b.com", "c.com"],
        ],
        null,
      ),
    ).toEqual(["a.com", "b.com", "c.com"]);
  });

  test("keeps to what the calling turn may reach, so the run is not refused", () => {
    expect(
      allowedHosts(
        [["api.example.com", "other.org", "*.example.com"]],
        ["*.example.com"],
      ),
    ).toEqual(["api.example.com", "*.example.com"]);
  });

  test("an empty calling scope leaves nothing, not everything", () => {
    expect(allowedHosts([["a.com"]], [])).toEqual([]);
  });

  test("is capped, keeping the earlier sources", () => {
    const many: string[] = [];
    for (let i = 0; i < MAX_HOSTS + 10; i++) many.push(`h${i}.com`);
    const hosts = allowedHosts([["first.com"], many], null);
    expect(hosts.length).toBe(MAX_HOSTS);
    expect(hosts[0]).toBe("first.com");
  });
});

describe("noticing a refused host", () => {
  test("recognises the engine's refusal", () => {
    expect(
      refusedAHost(
        "BlockedUrl: This execution may not reach 'evil.example' (allowed: a.com)",
      ),
    ).toBe(true);
    expect(refusedAHost("TypeError: x is undefined")).toBe(false);
  });
});
