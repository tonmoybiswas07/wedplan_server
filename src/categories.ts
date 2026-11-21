const categories = {
  "Photography & Videography": ["Photography", "Videography"],
  "Wedding Venues": ["Venue", "Venues", "Wedding Venue"],
  "Decoration & Florist": ["Decoration", "Flowers", "Florist"],
  "Catering Services": ["Catering"],
  "Makeup & Styling": ["Makeup", "Bridal Makeup", "Styling"],
  "Wedding Fashion": ["Fashion", "Bridal Fashion"],
} as const;

export function categoryNames(value: string): readonly string[] {
  return Object.entries(categories).map(([name, aliases]) => [name, ...aliases])
    .find((names) => names.some((name) => name.toLowerCase() === value.toLowerCase())) ?? [];
}

export function canonicalCategory(value: string) {
  return categoryNames(value)[0];
}
