// The one-line version of HLAE's hidden error dialog (src/render/controller/hlae-dialog.ts),
// from the window texts the 2026-10-25 FACEIT incident showed. No PowerShell runs here.
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { hlaeDialogLine, type WindowTexts } from "../src/render/controller/hlae-dialog.ts";

const win = (title: string, texts: string[], o: Partial<WindowTexts> = {}): WindowTexts =>
  ({ pid: 4242, title, className: "WindowsForms10.Window.8.app.0.1234_r3_ad1", visible: false, texts, ...o });
const INCIDENT = win("HLAE Error", ["Code: 2002", "Loader could not create requested process.", "GetLastWin32Error = 5: Access is denied", "Solution: Make sure to close any anti-cheat software and that the path to the game .exe is correct.", "OK"]);
const LINE = "HLAE error 2002: Loader could not create requested process. GetLastWin32Error = 5: Access is denied. Solution: Make sure to close any anti-cheat software and that the path to the game .exe is correct.";

test("the incident's hidden dialog becomes one line: the code first, the texts as sentences, the OK button dropped", () => {
  assert.equal(hlaeDialogLine([INCIDENT]), LINE);
  // Hidden or visible, and whatever else the loader has open, the dialog is what is reported.
  assert.equal(hlaeDialogLine([win("", [], { className: "ConsoleWindowClass", visible: true }), win("HLAE", []), win("Default IME", []), { ...INCIDENT, visible: true }]), LINE);
});

test("no HLAE window with texts means undefined, so the plain timeout reason stands", () => {
  assert.equal(hlaeDialogLine([]), undefined);
  assert.equal(hlaeDialogLine([win("HLAE", []), win("Error", ["Code: 2002", "Something else's dialog"]), win("Counter-Strike 2", ["text"])]), undefined);
  assert.equal(hlaeDialogLine([win("HLAE Error", ["OK", "&Cancel"])]), undefined, "buttons alone are no message");
});

test("without a code the title names the dialog; whitespace is collapsed; several dialogs are joined", () => {
  assert.equal(hlaeDialogLine([win("HLAE Warning", ["Could not\r\n  find  AfxHookSource2.dll"])]), 'HLAE dialog "HLAE Warning": Could not find AfxHookSource2.dll.');
  assert.equal(hlaeDialogLine([INCIDENT, win("HLAE Error", ["Code: 2003", "Injection failed"])]), `${LINE} | HLAE error 2003: Injection failed.`);
});
