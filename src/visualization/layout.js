const elk = new globalThis.ELK();

globalThis.monocarveLayout = { layoutCompound };

async function layoutCompound(nodes, edges) {
  const ownerGroups = group(nodes, ownerFor);
  const ownerLayouts = [];
  for (const [owner, members] of ownerGroups) ownerLayouts.push(await layoutOwner(owner, members, edges));
  const ownerByNode = lookup(ownerLayouts);
  const rootEdges = aggregateEdges(edges, (id) => ownerByNode.get(id));
  const root = await layoutFlat(ownerLayouts.map(asBox), rootEdges, 260, 140);
  return flatten(root, ownerLayouts);
}

async function layoutOwner(owner, nodes, edges) {
  const nestedGroups = group(
    nodes.filter((node) => nestedFor(node)),
    nestedFor,
  );
  const nestedLayouts = [];
  for (const [label, members] of nestedGroups) nestedLayouts.push(await layoutLeaves(`nested:${owner}:${label}`, label, members, edges, 150, 85));
  const nestedIds = new Set(nestedLayouts.flatMap((layout) => layout.members));
  const direct = nodes.filter((node) => !nestedIds.has(node.id));
  const nestedByNode = lookup(nestedLayouts);
  const itemId = (id) => nestedByNode.get(id) ?? id;
  const items = [...nestedLayouts.map(asBox), ...direct.map(asLeaf)];
  const memberIds = new Set(nodes.map((node) => node.id));
  const localEdges = aggregateEdges(
    edges.filter((edge) => memberIds.has(edge.from) && memberIds.has(edge.to) && itemId(edge.from) !== itemId(edge.to)),
    itemId,
  );
  const local = await layoutFlat(items, localEdges, 210, 100);
  return {
    id: `owner:${owner}`,
    label: owner,
    members: nodes.map((node) => node.id),
    local,
    children: nestedLayouts,
    width: local.width + 80,
    height: local.height + 105,
  };
}

async function layoutLeaves(id, label, nodes, edges, layerGap, nodeGap) {
  const ids = new Set(nodes.map((node) => node.id));
  const localEdges = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  const local = await layoutFlat(nodes.map(asLeaf), localEdges, layerGap, nodeGap);
  return { id, label, members: [...ids], local, children: [], width: local.width + 58, height: local.height + 82 };
}

async function layoutFlat(items, edges, layerGap, nodeGap) {
  if (items.length === 0) return { width: 1, height: 1, positions: new Map() };
  const result = await elk.layout({
    id: "layout",
    children: items,
    edges: edges.map((edge, index) => ({ id: `edge:${index}:${edge.from}:${edge.to}`, sources: [edge.from], targets: [edge.to] })),
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.spacing.nodeNode": String(nodeGap),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(layerGap),
      "elk.padding": "[top=25,left=25,bottom=25,right=25]",
      "elk.separateConnectedComponents": "true",
      "elk.spacing.componentComponent": String(nodeGap * 1.5),
    },
  });
  return {
    width: result.width ?? 1,
    height: result.height ?? 1,
    positions: new Map((result.children ?? []).map((child) => [child.id, { x: child.x ?? 0, y: child.y ?? 0 }])),
  };
}

function flatten(root, ownerLayouts) {
  const positions = new Map();
  const containers = [];
  for (const owner of ownerLayouts) {
    const rootPosition = root.positions.get(owner.id);
    const ownerX = (rootPosition?.x ?? 0) + 40;
    const ownerY = (rootPosition?.y ?? 0) + 65;
    containers.push({ id: owner.id, label: owner.label, x: rootPosition?.x ?? 0, y: rootPosition?.y ?? 0, width: owner.width, height: owner.height, depth: 0 });
    const childById = new Map(owner.children.map((child) => [child.id, child]));
    for (const [id, local] of owner.local.positions) {
      const child = childById.get(id);
      if (!child) positions.set(id, center(local, asLeafSize(id), ownerX, ownerY));
      else placeNested(child, local, ownerX, ownerY, positions, containers);
    }
  }
  return { positions, containers: containers.sort((left, right) => left.depth - right.depth || left.id.localeCompare(right.id)) };
}

function placeNested(groupLayout, local, ownerX, ownerY, positions, containers) {
  const x = ownerX + local.x;
  const y = ownerY + local.y;
  containers.push({ id: groupLayout.id, label: groupLayout.label, x, y, width: groupLayout.width, height: groupLayout.height, depth: 1 });
  for (const [id, leaf] of groupLayout.local.positions) positions.set(id, center(leaf, asLeafSize(id), x + 29, y + 52));
}

function center(position, size, offsetX, offsetY) {
  return { x: offsetX + position.x + size.width / 2, y: offsetY + position.y + size.height / 2 };
}
function asBox(layout) {
  return { id: layout.id, width: layout.width, height: layout.height };
}
function asLeaf(node) {
  return { id: node.id, ...asLeafSize(node.id, node.label) };
}
function asLeafSize(id, label = id) {
  return { width: Math.max(150, Math.min(300, 44 + label.length * 9)), height: 52 };
}

function aggregateEdges(edges, mapId) {
  const result = new Map();
  for (const edge of edges) {
    const from = mapId(edge.from);
    const to = mapId(edge.to);
    if (!from || !to || from === to) continue;
    result.set(`${from}->${to}`, { from, to });
  }
  return [...result.values()].sort((left, right) => `${left.from}->${left.to}`.localeCompare(`${right.from}->${right.to}`));
}

function lookup(layouts) {
  const result = new Map();
  for (const layout of layouts) for (const id of layout.members) result.set(id, layout.id);
  return result;
}

function group(nodes, keyFor) {
  const result = new Map();
  for (const node of nodes) {
    const key = keyFor(node);
    if (!key) continue;
    const entries = result.get(key) ?? [];
    entries.push(node);
    result.set(key, entries);
  }
  return [...result].sort(([left], [right]) => left.localeCompare(right));
}

function ownerFor(node) {
  return node.applications[0] ?? node.owners[0] ?? node.zones[0] ?? "unclassified";
}
function nestedFor(node) {
  const domain = node.domains[0] ?? "";
  const separator = domain.indexOf(":");
  if (separator < 0) return undefined;
  const suffix = domain.slice(separator + 1);
  return suffix.includes("/") ? `${domain.slice(0, separator)}:${suffix.split("/")[0]}` : undefined;
}
