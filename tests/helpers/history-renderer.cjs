// Expand the shared, stateless history views while keeping resource-owning
// children (the review sheet and membership timeline) under explicit mocks.
const views = new Set(['HistoryMemberStatus', 'HistoryLatestEvent', 'HistoryPrivateNote', 'HistoryMemberDetails', 'HistoryMemberDetailsSheet']);
function expandHistory(tree) {
  if (!tree || typeof tree !== 'object') return tree;
  if (Array.isArray(tree)) return tree.map(expandHistory);
  const rendered = typeof tree.type === 'function' && views.has(tree.type.name) ? tree.type(tree.props) : tree;
  return { ...rendered, props: { ...rendered.props, children: expandHistory(rendered.props?.children) } };
}
module.exports = { expandHistory };
