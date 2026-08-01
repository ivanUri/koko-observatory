import type { BrowserJourneyNode } from "./types";

const node = (id: string, type: BrowserJourneyNode["type"], title: string, description: string, process: string, thread: string): BrowserJourneyNode => ({
  id, type, title, description, process, thread, duration: 0, timestamp: 0, status: "pending", metadata: {},
});

export const browserJourneyNodes: BrowserJourneyNode[] = [
  node("response", "boundary", "Response received", "Network bytes cross into the browser processing pipeline.", "Browser", "Network"),
  node("decompression", "decode", "Content decoding", "gzip, Brotli, deflate or identity bytes are decoded.", "Browser", "Network"),
  node("cache", "cache", "Browser cache", "Classify memory, disk, service worker, revalidation or cache miss.", "Browser", "Network"),
  node("html-parser", "parser", "HTML parser", "Tokenizer and tree builder progressively construct the document.", "Renderer", "Main"),
  node("preload", "resource", "Preload scanner", "Discover CSS, scripts, images, fonts and hints in parallel.", "Renderer", "Preload"),
  node("dom", "dom", "DOM construction", "Tokens become nodes with parser-blocking boundaries preserved.", "Renderer", "Main"),
  node("css-parser", "parser", "CSS parser / CSSOM", "Stylesheets become rules, selectors and the CSS object model.", "Renderer", "Main"),
  node("javascript", "javascript", "JavaScript engine", "Compile and execute scripts at script-level granularity.", "Renderer", "Main"),
  node("event-loop", "scheduler", "Event loop", "Tasks, microtasks and animation callbacks run in defined order.", "Renderer", "Main"),
  node("mutations", "dom", "DOM updates", "Track inserted, removed and changed nodes and attributes.", "Renderer", "Main"),
  node("style", "render", "Style calculation", "Resolve cascade, inheritance and computed styles.", "Renderer", "Main"),
  node("layout", "render", "Layout", "Calculate box geometry and element coordinates.", "Renderer", "Main"),
  node("paint", "render", "Paint", "Generate display items and paint records.", "Renderer", "Main"),
  node("layers", "render", "Layerization", "Promote eligible content into composited layers.", "Renderer", "Compositor"),
  node("raster", "render", "Rasterization", "Raster threads convert tiles into bitmaps.", "Renderer", "Raster"),
  node("composite", "gpu", "GPU compositor", "Assemble layers and submit the frame.", "GPU", "Compositor"),
  node("frame", "boundary", "Frame presented", "The completed frame is ready on screen.", "GPU", "Compositor"),
];

const flow: Array<[string, string, string]> = [
  ["response", "decompression", "decode"], ["decompression", "cache", "classify"], ["cache", "html-parser", "HTML bytes"],
  ["html-parser", "preload", "parallel discovery"], ["html-parser", "dom", "tree building"],
  ["preload", "css-parser", "stylesheets"], ["preload", "javascript", "scripts"],
  ["javascript", "event-loop", "scheduled work"], ["event-loop", "mutations", "callbacks"], ["dom", "mutations", "updates"],
  ["dom", "style", "elements"], ["css-parser", "style", "CSSOM"], ["mutations", "style", "invalidation"],
  ["style", "layout", "computed styles"], ["layout", "paint", "geometry"], ["paint", "layers", "display list"],
  ["layers", "raster", "tiles"], ["raster", "composite", "bitmaps"], ["composite", "frame", "swap/present"],
];
export const browserJourneyEdges = flow.map(([source, target, reason], index) => ({ id: `browser-${index}`, source, target, label: reason }));
