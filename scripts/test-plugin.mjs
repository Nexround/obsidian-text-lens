import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { bytes } from "./native-test-utils.mjs";

/** Exercise the real command and note writer against a small Obsidian API double. */
export async function testPlugin(directory) {
  const stub = path.join(directory, "obsidian.cjs");
  await writeFile(stub, `
const state = { notices: [], controls: [] };
class TFile { constructor(path) { this.path=path; this.name=path; } }
class FileSystemAdapter { getBasePath() { return ${JSON.stringify(directory)}; } }
class Plugin { constructor(app) { this.app=app; this.manifest={id:"text-lens",version:"1.3.8"}; }
  async loadData() { return this.saved || {}; } async saveData(value) { this.saved=JSON.parse(JSON.stringify(value)); }
  addSettingTab(tab) { this.tab=tab; } addCommand(command) { this.command=command; } }
class PluginSettingTab { constructor() { this.containerEl={empty(){state.controls=[];},createEl(){}}; } }
class Modal {}
class Notice { constructor(message) { state.notices.push(message); } hide() {} setMessage(message) { state.notices.push(message); } }
class Setting { setName(){return this;} setDesc(){return this;} setHeading(){return this;}
  component(callback) { const control=new Proxy({disabled:false}, {get(target,key){if(key in target)return target[key];return (value)=>{if(key==="setDisabled")target.disabled=value;if(key==="onChange"||key==="onClick")target.callback=value;return control;};}});state.controls.push(control);callback(control);return this; }
  addDropdown(fn){return this.component(fn);} addToggle(fn){return this.component(fn);} addButton(fn){return this.component(fn);} addText(fn){return this.component(fn);} }
module.exports={Plugin,PluginSettingTab,Modal,Notice,Setting,TFile,FileSystemAdapter,MarkdownView:class{},state};
`);
  const pluginBundle = path.join(directory, "plugin.cjs");
  await build({ entryPoints: ["src/main.ts"], outfile: pluginBundle, bundle: true, format: "cjs", platform: "node",
    loader: { ".ps1": "text" }, plugins: [{name:"obsidian-double", setup(build){build.onResolve({filter:/^obsidian$/},()=>({path:stub,external:true}));}}], logLevel:"silent" });
  const require = createRequire(import.meta.url);
  const { default: Plugin } = require(pluginBundle);
  const { TFile, FileSystemAdapter, state } = require(stub);
  const note = new TFile("note.md");
  const images = new Map(["a.png", "b.png"].map((name) => [name, new TFile(name)]));
  const app = { vault: { adapter: new FileSystemAdapter(), configDir: ".custom-obsidian", getAbstractFileByPath: (name) => images.get(name), getResourcePath: (file) => file.path },
    workspace: { getActiveViewOfType: () => ({file:note}) } };
  const previousWindow = globalThis.window;
  globalThis.window = { fetch: async (name) => ({ ok:true, arrayBuffer: async () => bytes(name) }) };
  const plugin = new Plugin(app);
  try {
    plugin.saved = { localModelTier: "tiny" };
    await plugin.onload();
    assert.equal(plugin.settings.ocrSource, "paddle");
    assert.equal(plugin.settings.nativeLanguage, "auto");
    assert.ok(plugin.getPluginDir().includes(".custom-obsidian"));
    plugin.settings.ocrSource = "native";
    let resolveBatch, batchStarted, started;
    let batchCalls = 0, initializeCalls = 0, destroyed = false;
    const prepare = () => { started = new Promise((resolve) => { batchStarted = resolve; }); };
    plugin.engine = { ready:false, initialize:async () => {initializeCalls++;}, destroy:async () => {destroyed=true;},
      batchRecognize:async (_images, _concurrency, progress) => {batchCalls++;batchStarted();return new Promise((resolve)=>{resolveBatch=(items)=>{progress(items.length,items.length);resolve(items);};});} };
    let content = "![[a.png]]\n> [!note]+ OCR: a.png\n> Old A\n\n![[b.png]]\n> [!note]+ OCR: b.png\n> Old B\n";
    let transactions = 0;
    const editor = { getValue:()=>content, offsetToPos:(offset)=>({line:0,ch:offset}),
      transaction:(transaction)=>{transactions++;content=transaction.changes[0].text;} };
    const invoke = () => plugin.command.editorCallback(editor,{file:note});
    prepare();
    const pending = invoke();
    await started;
    assert.equal(plugin.busy,true);
    assert.ok(state.controls.every((control)=>control.disabled), "settings must be locked during recognition");
    await state.controls[0].callback("paddle");
    assert.equal(plugin.settings.ocrSource, "native", "locked source callbacks must not switch engines");
    await invoke();
    assert.equal(batchCalls,1,"duplicate command must not launch another batch");
    resolveBatch([{index:0,status:"fulfilled",value:["New A"]},{index:1,status:"rejected",reason:new Error("failed")}]);
    await pending;
    assert.equal(initializeCalls,1,"native source initializes without a Paddle runtime");
    assert.equal(transactions,1,"one transaction for a whole note");
    assert.match(content,/New A/);
    assert.doesNotMatch(content,/Old A/);
    assert.match(content,/Old B/,"failed image retains old OCR");
    assert.equal(plugin.busy,false);
    const fakeEngine = plugin.engine;
    await state.controls[0].callback("paddle");
    assert.equal(plugin.settings.ocrSource, "paddle");
    assert.equal(destroyed, true, "switching sources must dispose the previous engine");
    assert.notEqual(plugin.engine, fakeEngine);
    plugin.engine = fakeEngine;
    plugin.settings.ocrSource = "native";
    destroyed = false;
    prepare();
    const edited = invoke();
    await started;
    content += "User edit\n";
    resolveBatch([{index:0,status:"fulfilled",value:["Other A"]},{index:1,status:"fulfilled",value:["Other B"]}]);
    await edited;
    assert.equal(transactions,1,"concurrent note edits must not be overwritten");
    assert.match(content,/User edit/);
    prepare();
    const unloading = invoke();
    await started;
    plugin.onunload();
    resolveBatch([{index:0,status:"fulfilled",value:["Cancelled A"]},{index:1,status:"fulfilled",value:["Cancelled B"]}]);
    await unloading;
    assert.equal(destroyed,true);
    assert.equal(transactions,1,"unload must cancel writeback");
    console.log("PASS: plugin defaults, runtime independence, progress, settings lock, duplicate execution, rerun, failed-image preservation, one editor transaction, concurrent edits and unload cancellation.");
  } finally { plugin.onunload(); globalThis.window = previousWindow; }
}
