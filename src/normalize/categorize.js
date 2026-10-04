/** Category classification — config-driven, first match by configured precedence wins. */

function compile(categoriesConfig) {
  const matchers = [];
  for (const category of categoriesConfig.order) {
    const patterns = categoriesConfig.patterns[category] || [];
    matchers.push({
      category,
      regexes: patterns.map((p) => new RegExp(p, 'i')),
    });
  }
  return matchers;
}

export function createCategorizer(categoriesConfig) {
  const matchers = compile(categoriesConfig);
  const OTHER = categoriesConfig.order.includes('OTHER') ? 'OTHER' : 'OTHER';
  return function categorize({ title = '', description = '', source = '' } = {}) {
    const text = `${title} ${description} ${source}`.trim();
    for (const { category, regexes } of matchers) {
      if (regexes.some((re) => re.test(text))) return category;
    }
    return OTHER;
  };
}
