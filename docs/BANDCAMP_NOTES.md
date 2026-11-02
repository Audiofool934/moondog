# Bandcamp Notes

## Status

Research note, not a commitment.
It records why Bandcamp matters to the music-decentralization vision in [MUSIC_DECENTRALIZATION.md](MUSIC_DECENTRALIZATION.md).
It also records what the live Discover page showed in October 2026, and what Bandcamp's terms allow.
Revised on 2026-10-29 after a review of its claims against Bandcamp's terms and pages.

## Where the connection came from

A friend of the project recommended Bandcamp as a good fit for Moondog, in a conversation about the project's direction in October 2026.
The reasoning: many independent artists live there, outside the mainstream services.
The exposure problem that Moondog wants to solve is concentrated there.

## Bandcamp's terms and AI policy (checked 2026-10-29)

These terms decide what Moondog may build, so they come first.

- Bandcamp has no public catalog API.
  Its documented APIs (Account, Sales Report, and Merch Orders) serve labels and merchandise partners, for their own accounts, on request ([Bandcamp developer page](https://bandcamp.com/developer)).
  The site's own search and Discover pages call internal endpoints that are undocumented and not offered to other developers.
- The acceptable-use policy, part of the terms of use, forbids scraping by scripts, bots, or other automated means.
  It forbids text and data mining of site content.
  It forbids training an AI model on site content, or feeding any data or content from the platform into one.
  It forbids making fingerprints or other identifying files of site content.
  It also restricts "Unauthorized AI Tools", which it defines broadly: AI that uses, or is informed by, copyrighted works, names, or likenesses without the rights holders' authorization, and tools that depend on such AI ([acceptable-use policy](https://get.bandcamp.help/en/articles/15263124-bandcamp-s-acceptable-use-and-moderation-policy), updated 2026-06-10).
- A browser that tooling drives is still automated access.
  No Moondog tooling reads Bandcamp pages or endpoints without Bandcamp's written permission.
- Since 2026-01-13, Bandcamp does not permit music generated wholly or in substantial part by AI ([Keeping Bandcamp Human](https://blog.bandcamp.com/2026/01/13/keeping-bandcamp-human)).
  Its terms also promise that Bandcamp will not use, or let others use, an artist's music to train generation models without the artist's permission.

So written permission is unlikely for an AI tool.
For now, Bandcamp is a reference for discovery design, not a data source for Moondog.

## What the live Discover page shows (October 2026)

Observed on https://bandcamp.com/discover in a browser in October 2026.
Direct fetches meet a bot wall.

- 27 top-level genres, among them experimental, ambient, devotional, spoken word, comedy, audiobooks, and podcasts.
- Categories are product types, not genres: digital, vinyl, compact discs, cassettes, t-shirts.
  Discovering music and buying a physical copy are one flow.
- One sort and three filters are explicit: "best-selling" (the sort), "artists from anywhere" (location), "fresh" (recency), and "artists and labels I follow".
  There is no black-box "for you".
- Curation is human: Bandcamp Daily features, artist pick lists, label guides, and Bandcamp Radio.
- Each result card carries a genre tag, the title, and the artist.
  Location is a filter, a search term, and a line in the panel for the selected release, so scenes stay visible as a discovery dimension.

## Why this still matters to Moondog

- An artist or label page is close to a self-describing package: metadata, and often credits, lyrics, and lossless downloads.
  Credits and lyrics are optional fields that artists fill in.
  The artist package format in the decentralization vision is most of the way to existing here.
  What is missing is an open read path to the recordings.
  From the recordings, Moondog would compute its own embeddings and sound descriptors.
  Moondog may not read Bandcamp's site for that, so an artist would publish the package from their own masters, outside Bandcamp.
- Fans buy files, not only access.
  Purchases come with downloads, including lossless formats such as FLAC and ALAC, licensed for personal, non-commercial use.
  An owned collection is collection evidence, kept apart from listening evidence: a purchase records no plays.
  This audience may overlap with the people who digitize their CD shelves.
- Both approaches to discovery reject a black-box feed.
  Bandcamp uses human curation and explicit filters.
  Moondog uses a profile that shows its evidence.
  They do not compete: Bandcamp sells music, and Moondog helps one listener understand their own listening.
- Bandcamp tags are free text that artists enter, far finer than streaming genres.
  An agent that connects profile evidence to those tags could give small artists a recommendation reach that streaming systems have not given them.

## Possible first slices

- A link-out experiment.
  The agent proposes Bandcamp genre, tag, or location searches with grounded reasons from the profile, and the listener opens the links by hand.
  Moondog never reads Bandcamp content.
  Test it with a fictional listener first, and check that the reasons attach to the free-tag system without invented evidence.
- An import of files that the listener downloaded by hand from their own collection, inside the local-library stage.
  It follows the same show-what-is-inside-first rule as every other importer.
  It waits for the source-terms gate in the vision, because Bandcamp's AI and fingerprint clauses may reach downloaded copies.
  Moondog never imports another person's public collection, and never automates fan or Discover pages.
- Anything that reads Bandcamp pages or endpoints, such as a Discover experiment or an index, needs Bandcamp's written permission first.
