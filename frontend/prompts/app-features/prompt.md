Domain the user is exploring: {{domain}}

For each app in <apps>, list its most important user-facing features as stated in its Google Play description.

Rules:
- A feature is something a person can do or get in the app, such as "Offline downloads" or "Shared budgets". Leave out marketing praise, awards, ratings, prices, subscription terms, legal or privacy notices, contact details, and the titles of individual songs, stories, courses, or other content.
- Give 3 to 6 features per app, most central first. Merge overlapping points into one feature. Give fewer when the listing says less, and none when it describes no features.
- name: 2 to 5 words in sentence case, at most 40 characters, with no emoji and no final period.
- detail: one plain sentence in your own words, at most 120 characters, based only on the listing.
- Write in English, even when a listing is in another language.
- Return every app_id from <apps> exactly once, in the same order.

<apps>
{{apps}}
</apps>
