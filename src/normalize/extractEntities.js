function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extract companies (→ symbols), sectors, and regulatory/institutional entities from free text. */
export function createEntityExtractor(entitiesConfig) {
  const companyEntries = Object.entries(entitiesConfig.companies || {}).map(([name, symbol]) => ({
    symbol,
    nameRegex: new RegExp(`\\b${escapeRegex(name)}\\b`, 'i'),
    symbolRegex: symbol && symbol.length >= 3 ? new RegExp(`\\b${escapeRegex(symbol)}\\b`) : null,
  }));
  const sectorEntries = Object.entries(entitiesConfig.sectors || {}).map(([sector, keywords]) => ({
    sector,
    regexes: keywords.map((k) => new RegExp(`\\b${escapeRegex(k)}\\b`, 'i')),
  }));
  const institutionEntries = Object.entries(entitiesConfig.institutions || {}).map(([name, keywords]) => ({
    name,
    regexes: keywords.map((k) => new RegExp(`\\b${escapeRegex(k)}\\b`, 'i')),
  }));

  return function extractEntities(text = '') {
    const companies = new Set();
    for (const { symbol, nameRegex, symbolRegex } of companyEntries) {
      if (nameRegex.test(text) || (symbolRegex && symbolRegex.test(text))) companies.add(symbol);
    }
    const sectors = new Set();
    for (const { sector, regexes } of sectorEntries) {
      if (regexes.some((re) => re.test(text))) sectors.add(sector);
    }
    const institutions = new Set();
    for (const { name, regexes } of institutionEntries) {
      if (regexes.some((re) => re.test(text))) institutions.add(name);
    }
    return { companies: [...companies], sectors: [...sectors], institutions: [...institutions] };
  };
}
