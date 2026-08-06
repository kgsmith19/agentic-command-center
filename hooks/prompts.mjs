#!/usr/bin/env node
// prompts.mjs — local-file prompt storage: list/show/add/update/remove
// against a folder of plain text files. First cut of a store that moves to
// an outside API later (Kyle, 2026-08-02) — kept behind this small surface
// so that migration is a backend swap for callers, not a rewrite.
//
//   node hooks/prompts.mjs list
//   node hooks/prompts.mjs show <name>
//   node hooks/prompts.mjs add <name> <text...>
//   node hooks/prompts.mjs update <name> <text...>
//   node hooks/prompts.mjs remove <name>
//
// Storage: ACC_PROMPTS_DIR override, else <repo>/runner/prompts/<name>.txt —
// mirrors the existing runner/jobs, runner/missions convention (a plain folder
// ACC already owns). Text is stored byte-for-byte: this module never
// rewrites, reformats, or truncates what it's given.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = () => process.env.ACC_PROMPTS_DIR || path.join(HERE, "..", "runner", "prompts");

// A prompt name is a filename, never a path the caller controls into —
// basename only, no traversal.
export function safeName(name) {
  const n = String(name || "").trim();
  if (!n || n !== path.basename(n) || n.includes("..")) {
    throw new Error(`invalid prompt name: ${JSON.stringify(name)}`);
  }
  return n;
}

function fileFor(name) {
  return path.join(DIR(), `${safeName(name)}.txt`);
}

export function listPrompts() {
  let files = [];
  try { files = fs.readdirSync(DIR()).filter((f) => f.endsWith(".txt")); } catch {}
  return files.map((f) => f.slice(0, -4)).sort();
}

export function readPrompt(name) {
  return fs.readFileSync(fileFor(name), "utf8");
}

export function addPrompt(name, text) {
  const f = fileFor(name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (fs.existsSync(f)) throw new Error(`prompt already exists: ${name}`);
  fs.writeFileSync(f, String(text ?? ""));
}

export function updatePrompt(name, text) {
  const f = fileFor(name);
  if (!fs.existsSync(f)) throw new Error(`no such prompt: ${name}`);
  fs.writeFileSync(f, String(text ?? ""));
}

// Convenience for callers that don't care about the add/update distinction.
export function upsertPrompt(name, text) {
  const f = fileFor(name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, String(text ?? ""));
}

export function removePrompt(name) {
  const f = fileFor(name);
  if (!fs.existsSync(f)) throw new Error(`no such prompt: ${name}`);
  fs.unlinkSync(f);
}

export function runCli(argv) {
  const [cmd, name, ...rest] = argv;
  const text = rest.join(" ");
  switch (cmd) {
    case "list": return listPrompts();
    case "show": return readPrompt(name);
    case "add": addPrompt(name, text); return { ok: true };
    case "update": updatePrompt(name, text); return { ok: true };
    case "remove": removePrompt(name); return { ok: true };
    default: throw new Error(`unknown command: ${cmd} (list|show|add|update|remove)`);
  }
}

function main() {
  try {
    const out = runCli(process.argv.slice(2));
    console.log(typeof out === "string" ? out : JSON.stringify(out));
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
