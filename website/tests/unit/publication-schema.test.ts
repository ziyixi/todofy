import { describe, expect, it } from "vitest";

import { PublicationSchema } from "../../src/lib/content/schema";

const publication = {
  id: "pyfk-conference",
  title: "PyFK",
  authors: [{ name: "Ziyi Xi", siteOwner: true }],
  venue: "AGU Fall Meeting",
  year: 2021,
  homeAuthors: "Z. Xi et al.",
};

describe("publication resources", () => {
  it.each(["Publisher", "Code"] as const)(
    "supports a publication without a DOI when it has a %s link",
    (label) => {
      expect(() =>
        PublicationSchema.parse({
          ...publication,
          links: [{ label, url: "https://example.com/pyfk" }],
        }),
      ).not.toThrow();
    },
  );

  it("rejects a publication without any DOI or resource", () => {
    expect(() => PublicationSchema.parse({ ...publication, links: [] })).toThrow(/resource link/);
  });

  it("retains the DOI-only fallback for existing publications", () => {
    expect(() =>
      PublicationSchema.parse({ ...publication, doi: "10.1234/example", links: [] }),
    ).not.toThrow();
  });
});
