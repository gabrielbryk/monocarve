const { DataSet, Network } = globalThis.vis;
const networkElement = element("network");
const detailsElement = element("details");
const statusElement = element("status");
const searchElement = element("search");
const viewElement = element("view");
const scopeElement = element("scope");
const densityElement = element("density");
const contrastElement = element("contrast");
const kindElement = element("kind");
const refreshElement = element("refresh");
let graph;
let network;
let scopeInitialized = false;
let renderVersion = 0;
let renderedContainers = [];

const options = {
  interaction: { hover: true, hoverConnectedEdges: true, navigationButtons: true },
  physics: false,
  nodes: { shape: "dot", borderWidth: 1, font: { color: "#e7eaf0", face: "system-ui", size: 12 } },
  edges: {
    arrows: { to: { enabled: true, scaleFactor: 0.45 } },
    color: { color: "rgba(94, 112, 145, 0.20)", highlight: "#a7b8ff", hover: "#8ca5ff" },
    selectionWidth: 2.5,
    smooth: { enabled: true, type: "cubicBezier", roundness: 0.35 },
  },
};

async function loadGraph(rescan = false) {
  refreshElement.disabled = true;
  statusElement.textContent = rescan ? "Rescanning…" : "Loading…";
  const response = await fetch(rescan ? "/api/rescan" : "/api/graph", { method: rescan ? "POST" : "GET" });
  if (!response.ok) throw new Error(await response.text());
  graph = await response.json();
  fillScopes();
  fillKinds();
  await render();
  refreshElement.disabled = false;
}

async function render() {
  const version = ++renderVersion;
  const highContrast = contrastElement.value === "high";
  document.body.dataset.contrast = highContrast ? "high" : "dark";
  const query = searchElement.value.trim().toLowerCase();
  const scope = scopeElement.value;
  const kind = kindElement.value;
  const displayed = viewElement.value === "domains" ? domainGraph(graph) : graph;
  const visibleNodes = displayed.nodes.filter((node) => inScope(node, scope) && (!query || nodeSearchText(node).includes(query)));
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const scopedEdges = displayed.edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to) && (!kind || edge.kinds.includes(kind)));
  const overview = viewElement.value === "domains";
  const hierarchyEdges = overview && densityElement.value === "hierarchy" ? connectivityBackbone(visibleNodes, scopedEdges) : undefined;
  const visibleEdges = hierarchyEdges
    ?? (overview && densityElement.value === "backbone" ? backboneEdges(visibleNodes, scopedEdges) : scopedEdges);
  const compound = overview ? await globalThis.monocarveLayout.layoutCompound(visibleNodes, visibleEdges) : undefined;
  if (version !== renderVersion) return;
  const positions = compound?.positions ?? componentPositions(visibleNodes);
  renderedContainers = compound?.containers ?? [];
  const colorKeys = visibleNodes.map((node) => groupFor(node));
  const colors = colorsFor(colorKeys);
  const nodes = new DataSet(visibleNodes.map((node) => {
    const colorKey = groupFor(node);
    return renderNode(node, positions.get(node.id), colors.get(colorKey), highContrast);
  }));
  const edges = new DataSet(visibleEdges.map((edge) => renderEdge(edge, overview, highContrast)));
  if (network) network.destroy();
  network = new Network(networkElement, { nodes, edges }, options);
  network.on("beforeDrawing", (context) => drawContainers(context, renderedContainers, colors, highContrast));
  network.on("selectNode", ({ nodes: selected }) => {
    const id = selected[0];
    if (id) network.selectEdges(network.getConnectedEdges(id));
    showDetails(visibleNodes.find((node) => node.id === id));
  });
  network.on("doubleClick", ({ nodes: selected }) => drillInto(visibleNodes.find((node) => node.id === selected[0])));
  setTimeout(() => {
    network.fit({ animation: false });
  }, 50);
  const noun = viewElement.value === "domains" ? "domains" : "components";
  const clusters = compound ? ` · ${compound.containers.length} nested groups · ELK layered` : "";
  statusElement.textContent = `${visibleNodes.length}/${displayed.nodes.length} ${noun} · ${visibleEdges.length} connections${clusters} · ${short(graph.commit)}`;
}

function drawContainers(context, containers, colors, highContrast) {
  context.save();
  for (const box of containers) {
    const color = colors.get(box.label) ?? colors.get(box.label.split(":")[0]) ?? "#64748b";
    context.fillStyle = highContrast ? (box.depth === 0 ? "rgba(226,232,240,.48)" : "rgba(248,250,252,.74)") : "rgba(21,25,34,.58)";
    context.strokeStyle = highContrast ? color : `${color}aa`;
    context.lineWidth = highContrast ? Math.max(3, 6 - box.depth) : Math.max(1.5, 4 - box.depth);
    context.setLineDash(box.depth > 1 ? [10, 7] : []);
    context.beginPath();
    context.roundRect(box.x, box.y, box.width, box.height, 16);
    context.fill();
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = highContrast ? "#111827" : "#e7eaf0";
    context.font = `${box.depth === 0 ? "700 24px" : "650 18px"} system-ui`;
    context.fillText(box.label, box.x + 18, box.y + 32);
  }
  context.restore();
}

function renderNode(node, position, color, highContrast) {
  return {
    id: node.id, label: node.label, x: position.x, y: position.y, fixed: true,
    shape: node.summary ? "box" : "dot", value: Math.max(8, Math.sqrt(node.lineCount)),
    color: highContrast ? { background: "#ffffff", border: color, highlight: { background: "#fff7cc", border: "#000000" }, hover: { background: "#f3f4f6", border: color } } : color,
    borderWidth: highContrast ? 4 : 1,
    font: { color: highContrast ? "#000000" : "#e7eaf0", face: "system-ui", size: node.summary ? 18 : 13, bold: node.summary ? "700" : "500" },
    title: `${node.members.length} file(s), ${node.lineCount} lines`,
  };
}

function renderEdge(edge, overview, highContrast) {
  const width = overview ? Math.min(highContrast ? 5 : 2.5, (highContrast ? 2 : 0.4) + Math.log2(edge.count + 1) * 0.4) : Math.min(8, 1 + Math.log2(edge.count));
  const color = highContrast ? { color: "#111827", highlight: "#dc2626", hover: "#2563eb", opacity: 1 } : undefined;
  return { id: edge.id, from: edge.from, to: edge.to, width, ...(color ? { color } : {}), title: `${edge.count} ${edge.kinds.join(", ")}` };
}

function showDetails(node) {
  if (!node) return;
  detailsElement.replaceChildren();
  const title = document.createElement("h2");
  title.textContent = node.label;
  detailsElement.append(title, metric("Files", node.members.length), metric("Lines", node.lineCount), metric("Layer", node.layer), metric("Cycle", node.cyclic ? "yes" : "no"));
  if (node.summary) {
    const hint = document.createElement("p");
    hint.textContent = "Double-click this domain to inspect its SCCs.";
    detailsElement.append(hint);
  }
  const list = document.createElement("ul");
  for (const member of node.members) {
    const item = document.createElement("li");
    const code = document.createElement("code");
    code.textContent = member;
    item.append(code);
    list.append(item);
  }
  detailsElement.append(list);
}

function metric(name, value) {
  const row = document.createElement("div");
  row.className = "metric";
  const label = document.createElement("span");
  const output = document.createElement("strong");
  label.textContent = name;
  output.textContent = String(value);
  row.append(label, output);
  return row;
}

function fillKinds() {
  const previous = kindElement.value;
  const kinds = [...new Set(graph.edges.flatMap((edge) => edge.kinds))].sort();
  kindElement.replaceChildren(new Option("All edge kinds", ""), ...kinds.map((kind) => new Option(kind, kind)));
  kindElement.value = kinds.includes(previous) ? previous : "";
}

function fillScopes() {
  const previous = scopeElement.value;
  const applications = counts(graph.nodes.flatMap((node) => node.applications));
  const domains = counts(graph.nodes.flatMap((node) => node.domains));
  const overview = viewElement.value === "domains";
  const options = [new Option(overview ? `All domains (${domains.length})` : `All components (${graph.nodes.length})`, "")];
  for (const [name, count] of applications) options.push(new Option(`Application: ${name} (${count})`, `application:${name}`));
  if (!overview) for (const [name, count] of domains) options.push(new Option(`Domain: ${name} (${count})`, `domain:${name}`));
  scopeElement.replaceChildren(...options);
  const values = new Set(options.map((option) => option.value));
  scopeElement.value = scopeInitialized && values.has(previous) ? previous : overview ? "" : domains[0] ? `domain:${domains[0][0]}` : "";
  scopeInitialized = true;
}

function domainGraph(source) {
  const byId = new Map(source.nodes.map((node) => [node.id, node]));
  const domainForId = new Map(source.nodes.map((node) => [node.id, node.domains[0] ?? "unclassified"]));
  const groups = new Map();
  for (const node of source.nodes) {
    const domain = domainForId.get(node.id);
    const group = groups.get(domain) ?? { id: `domain:${domain}`, label: domain, members: [], applications: new Set(), domains: [domain], owners: new Set(), zones: new Set(), lineCount: 0, layer: 0, cyclic: false, summary: true };
    group.members.push(...node.members);
    node.applications.forEach((value) => group.applications.add(value));
    node.owners.forEach((value) => group.owners.add(value));
    node.zones.forEach((value) => group.zones.add(value));
    group.lineCount += node.lineCount;
    group.layer = Math.max(group.layer, node.layer);
    group.cyclic ||= node.cyclic;
    groups.set(domain, group);
  }
  const nodes = [...groups.values()].map((group) => ({ ...group, members: group.members.sort(), applications: [...group.applications].sort(), owners: [...group.owners].sort(), zones: [...group.zones].sort() })).sort((left, right) => left.id.localeCompare(right.id));
  const aggregates = new Map();
  for (const edge of source.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    const from = `domain:${domainForId.get(edge.from)}`;
    const to = `domain:${domainForId.get(edge.to)}`;
    if (from === to) continue;
    const id = `${from}->${to}`;
    const aggregate = aggregates.get(id) ?? { id, from, to, kinds: new Set(), count: 0 };
    edge.kinds.forEach((kind) => aggregate.kinds.add(kind));
    aggregate.count += edge.count;
    aggregates.set(id, aggregate);
  }
  const edges = [...aggregates.values()].map((edge) => ({ ...edge, kinds: [...edge.kinds].sort() })).sort((left, right) => left.id.localeCompare(right.id));
  return { nodes, edges };
}

function backboneEdges(nodes, edges) {
  const layers = new Map(nodes.map((node) => [node.id, node.layer]));
  const selected = new Map();
  for (const node of nodes) {
    const outgoing = edges.filter((edge) => edge.from === node.id).sort((left, right) => edgePriority(left, right, layers));
    const incoming = edges.filter((edge) => edge.to === node.id).sort((left, right) => edgePriority(left, right, layers));
    if (outgoing[0]) selected.set(outgoing[0].id, outgoing[0]);
    if (incoming[0]) selected.set(incoming[0].id, incoming[0]);
  }
  return [...selected.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function connectivityBackbone(nodes, edges) {
  const layers = new Map(nodes.map((node) => [node.id, node.layer]));
  const selected = new Map(dependencyForest(nodes, edges).edges.map((edge) => [edge.id, edge]));
  const parent = new Map(nodes.map((node) => [node.id, node.id]));
  const find = (id) => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    while (id !== root) {
      const next = parent.get(id);
      parent.set(id, root);
      id = next;
    }
    return root;
  };
  const connect = (from, to) => {
    const left = find(from);
    const right = find(to);
    if (left === right) return false;
    parent.set(right, left);
    return true;
  };
  for (const edge of selected.values()) connect(edge.from, edge.to);
  const candidates = edges.filter((edge) => !selected.has(edge.id)).sort((left, right) => edgePriority(left, right, layers));
  for (const edge of candidates) if (connect(edge.from, edge.to)) selected.set(edge.id, edge);
  return [...selected.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function edgePriority(left, right, layers) {
  return right.count - left.count
    || Math.abs((layers.get(left.from) ?? 0) - (layers.get(left.to) ?? 0)) - Math.abs((layers.get(right.from) ?? 0) - (layers.get(right.to) ?? 0))
    || left.id.localeCompare(right.id);
}

function drillInto(node) {
  if (!node?.summary) return;
  viewElement.value = "components";
  scopeInitialized = true;
  fillScopes();
  scopeElement.value = `domain:${node.domains[0]}`;
  void render().catch(showError);
}

function counts(values) {
  const result = new Map();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return [...result].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

function componentPositions(nodes) {
  const layers = new Map();
  for (const node of nodes) {
    const entries = layers.get(node.layer) ?? [];
    entries.push(node);
    layers.set(node.layer, entries);
  }
  const positions = new Map();
  for (const [layer, entries] of layers) {
    entries.sort((left, right) => left.id.localeCompare(right.id));
    entries.forEach((node, index) => positions.set(node.id, { x: -layer * 230, y: (index - (entries.length - 1) / 2) * 65 }));
  }
  return positions;
}

function dependencyForest(nodes, edges) {
  const layers = new Map(nodes.map((node) => [node.id, node.layer]));
  const parentEdges = new Map();
  for (const node of nodes) {
    const best = edges.filter((edge) => edge.from === node.id).sort((left, right) => edgePriority(left, right, layers))[0];
    if (best) parentEdges.set(node.id, best);
  }
  breakParentCycles(nodes, parentEdges);
  const children = new Map(nodes.map((node) => [node.id, []]));
  for (const [child, edge] of parentEdges) children.get(edge.to)?.push(child);
  const sizes = new Map();
  const sizeOf = (id) => {
    if (sizes.has(id)) return sizes.get(id);
    const size = 1 + (children.get(id) ?? []).reduce((sum, child) => sum + sizeOf(child), 0);
    sizes.set(id, size);
    return size;
  };
  const roots = nodes.filter((node) => !parentEdges.has(node.id)).sort((left, right) => sizeOf(right.id) - sizeOf(left.id) || left.id.localeCompare(right.id));
  const trees = roots.map((root) => layoutTree(root.id, children, sizes));
  const columnWidth = Math.max(900, ...trees.map((tree) => tree.width + 420));
  const columns = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(trees.length))));
  const columnHeights = Array.from({ length: columns }, () => 0);
  const positions = new Map();
  const clusterByNode = new Map();
  for (const [index, tree] of trees.entries()) {
    const column = columnHeights.indexOf(Math.min(...columnHeights));
    const offsetX = column * columnWidth;
    const offsetY = columnHeights[column];
    for (const [id, position] of tree.positions) {
      positions.set(id, { x: position.x + offsetX, y: position.y + offsetY });
      clusterByNode.set(id, roots[index].id);
    }
    columnHeights[column] += tree.height + 360;
  }
  return { roots, positions, clusterByNode, edges: [...parentEdges.values()].sort((left, right) => left.id.localeCompare(right.id)) };
}

function breakParentCycles(nodes, parentEdges) {
  for (const node of nodes) {
    const path = [];
    const seen = new Map();
    let current = node.id;
    while (parentEdges.has(current) && !seen.has(current)) {
      seen.set(current, path.length);
      path.push(current);
      current = parentEdges.get(current).to;
    }
    const start = seen.get(current);
    if (start !== undefined) parentEdges.delete([...path.slice(start)].sort()[0]);
  }
}

function layoutTree(root, children, sizes) {
  const positions = new Map();
  let nextLeaf = 0;
  let maxDepth = 0;
  const place = (id, depth) => {
    maxDepth = Math.max(maxDepth, depth);
    const descendants = [...(children.get(id) ?? [])].sort((left, right) => sizes.get(right) - sizes.get(left) || left.localeCompare(right));
    if (descendants.length === 0) {
      const y = nextLeaf++ * 120;
      positions.set(id, { x: -depth * 340, y });
      return y;
    }
    const childYs = descendants.map((child) => place(child, depth + 1));
    const y = childYs.reduce((sum, value) => sum + value, 0) / childYs.length;
    positions.set(id, { x: -depth * 340, y });
    return y;
  };
  place(root, 0);
  return { positions, width: maxDepth * 340, height: Math.max(120, nextLeaf * 120) };
}

function groupFor(node) { return node.applications[0] ?? node.owners[0] ?? node.zones[0] ?? "unclassified"; }

function inScope(node, scope) {
  if (!scope) return true;
  const separator = scope.indexOf(":");
  const kind = scope.slice(0, separator);
  const value = scope.slice(separator + 1);
  return kind === "application" ? node.applications.includes(value) : node.domains.includes(value);
}

function nodeSearchText(node) { return [...node.members, ...node.applications, ...node.domains, ...node.owners, ...node.zones].join(" ").toLowerCase(); }
function colorsFor(keys) {
  const palette = ["#4f8cff", "#ff8a4c", "#45c486", "#d755c7", "#e1bd31", "#8b75ef", "#e45f72", "#35b9c8"];
  return new Map([...new Set(keys)].sort().map((group, index) => [group, palette[index % palette.length]]));
}
function short(value) { return value?.slice(0, 10) ?? "working tree"; }
function element(id) { const found = document.getElementById(id); if (!found) throw new Error(`missing #${id}`); return found; }

searchElement.addEventListener("input", () => void render().catch(showError));
viewElement.addEventListener("change", () => { scopeInitialized = false; fillScopes(); void render().catch(showError); });
scopeElement.addEventListener("change", () => void render().catch(showError));
densityElement.addEventListener("change", () => void render().catch(showError));
contrastElement.addEventListener("change", () => void render().catch(showError));
kindElement.addEventListener("change", () => void render().catch(showError));
refreshElement.addEventListener("click", () => void loadGraph(true).catch(showError));
void loadGraph().catch(showError);
function showError(error) { statusElement.textContent = error instanceof Error ? error.message : String(error); refreshElement.disabled = false; }
