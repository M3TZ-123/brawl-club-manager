function readOnlyDatabase(tables) {
  return {
    from(table) {
      if (!Object.hasOwn(tables, table)) throw new Error(`Missing fixture for ${table}`);
      const filters = [];
      const ordering = [];
      let offset = 0;
      let end = Infinity;
      let single = false;
      const query = {
        select() { return query; },
        eq(key, value) { filters.push(row => row[key] === value); return query; },
        neq(key, value) { filters.push(row => row[key] != null && row[key] !== value); return query; },
        gt(key, value) { filters.push(row => row[key] > value); return query; },
        gte(key, value) { filters.push(row => row[key] >= value); return query; },
        lt(key, value) { filters.push(row => row[key] < value); return query; },
        lte(key, value) { filters.push(row => row[key] <= value); return query; },
        in(key, values) { filters.push(row => values.includes(row[key])); return query; },
        order(key, options = {}) { ordering.push([key, options.ascending !== false]); return query; },
        range(from, to) { offset = from; end = to + 1; return query; },
        limit(count) { end = offset + count; return query; },
        maybeSingle() { single = true; return query; },
        single() { single = true; return query; },
        then(resolve, reject) {
          const rows = tables[table].filter(row => filters.every(filter => filter(row)));
          rows.sort((a, b) => {
            for (const [key, ascending] of ordering) {
              const comparison = a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0;
              if (comparison) return ascending ? comparison : -comparison;
            }
            return 0;
          });
          const data = rows.slice(offset, end).map(row => ({ ...row }));
          return Promise.resolve({ data: single ? data[0] ?? null : data, error: null, count: rows.length }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

module.exports = { readOnlyDatabase };
