const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { hookRenderer, elements, textContent } = require("./helpers/client-renderer.cjs");

const { BattleModeIcon } = loadTypeScript("src/components/battle-mode-icon.tsx", {
  "@/components/brawl-image": { BrawlImage: "BrawlImage" },
  "lucide-react": { Swords: "Swords" },
});

test("mode icons use the catalog image for aliases and source IDs without another catalog request", () => {
  const hockey = BattleModeIcon({ mode: "airHockey", size: 24 });
  assert.equal(hockey.type, "BrawlImage");
  assert.equal(hockey.props.src, "https://cdn.brawlify.com/game-modes/regular/48000045.png");
  assert.equal(hockey.props.width, 24); assert.equal(hockey.props.height, 24);
  assert.equal(hockey.props.alt, "");
  assert.equal(hockey.props.fallback.type, "Swords");
  const identified = BattleModeIcon({ mode: "unknownInternalName", modeId: 0 });
  assert.equal(identified.props.src, "https://cdn.brawlify.com/game-modes/regular/48000000.png");
  assert.equal(identified.props.width, 20);
});

test("mode info objects are supported and explicit accessible labels remain intact", () => {
  const icon = BattleModeIcon({ mode: { key: "gemGrab", label: "Gem Grab", imageUrl: "https://cdn.brawlify.com/game-modes/regular/48000000.png" }, label: "جمع الجواهر", className: "text-primary" });
  assert.equal(icon.type, "BrawlImage");
  assert.equal(icon.props.alt, "جمع الجواهر");
  assert.match(icon.props.className, /text-primary/);
});

test("unknown modes use a stable SVG fallback without inventing a URL or duplicating adjacent labels", () => {
  for (const mode of [null, undefined, "futureEvent2027", "loaded SD"]) {
    const icon = BattleModeIcon({ mode, size: 18 });
    assert.equal(icon.type, "span");
    assert.equal(icon.props["aria-hidden"], true);
    assert.equal(icon.props.style.width, 18); assert.equal(icon.props.style.height, 18);
    assert.equal(elements(icon).some(node => node.type === "BrawlImage"), false);
    assert.equal(elements(icon).find(node => node.type === "Swords").props["aria-hidden"], "true");
    assert.equal(textContent(icon), "");
  }
  const standalone = BattleModeIcon({ mode: "futureEvent2027", label: "Future Event" });
  assert.equal(standalone.props.role, "img");
  assert.equal(standalone.props["aria-label"], "Future Event");
  assert.equal(standalone.props["aria-hidden"], undefined);
});

test("failed game icons keep the supplied SVG fallback and decorative accessibility while new URLs recover", async () => {
  const renderer = hookRenderer();
  const { BrawlImage } = loadTypeScript("src/components/brawl-image.tsx", { react: renderer.react, "next/image": "Image", "lucide-react": { ImageOff: "ImageOff" } });
  const props = BattleModeIcon({ mode: "gemGrab", size: 22 }).props;
  let src = props.src;
  const render = () => renderer.render(() => BrawlImage({ ...props, src }));
  let tree = await render(); tree.props.onError(); tree = await render();
  assert.equal(tree.type, "span"); assert.equal(tree.props["aria-hidden"], true);
  assert.equal(tree.props.style.width, 22); assert.equal(tree.props.style.height, 22);
  assert.equal(elements(tree).some(node => node.type === "Swords"), true);
  src = "https://cdn.brawlify.com/game-modes/regular/48000002.png";
  tree = await render(); assert.equal(tree.type, "Image"); assert.equal(tree.props.src, src);
});
