const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const ts = require("typescript");

const projectRoot = path.resolve(__dirname, "../..");

// Execute the real TypeScript modules with explicit dependency replacements.
// Unexpected HTTP requests fail so regression tests cannot touch live services.
function loadTypeScript(relativePath, mocks = {}, globals = {}) {
  const cache = new Map();
  const context = vm.createContext({
    console, URL, URLSearchParams, Request, Response, Headers,
    AbortController, AbortSignal, Buffer, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, setInterval, clearInterval,
    process: { ...process, env: { ...process.env, NODE_ENV: "test" } },
    fetch: async () => { throw new Error("Unexpected network request in regression test"); },
    ...globals,
  });

  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const loadedModule = { exports: {} };
    cache.set(filename, loadedModule);
    const nodeRequire = createRequire(filename);
    const requireModule = (id) => {
      if (Object.hasOwn(mocks, id)) return mocks[id];
      if (id === "server-only") return {};
      const localPath = id.startsWith("@/")
        ? path.join(projectRoot, "src", id.slice(2))
        : id.startsWith(".") ? path.resolve(path.dirname(filename), id) : null;
      if (localPath) {
        const resolved = [localPath, `${localPath}.ts`, `${localPath}.tsx`, path.join(localPath, "index.ts")]
          .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
        if (resolved && /\.tsx?$/.test(resolved)) return load(resolved);
      }
      return nodeRequire(id);
    };
    const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
      fileName: filename,
    });
    const evaluate = vm.runInContext(`(function(require,module,exports,__filename,__dirname){\n${outputText}\n})`, context, { filename });
    evaluate(requireModule, loadedModule, loadedModule.exports, filename, path.dirname(filename));
    return loadedModule.exports;
  }

  return load(path.resolve(projectRoot, relativePath));
}

module.exports = { loadTypeScript };
