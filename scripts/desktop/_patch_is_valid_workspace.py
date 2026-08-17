#!/usr/bin/env python3
from pathlib import Path

# --- NewChatDialog.tsx ---
path = Path("/home/code/pravite_fund_ai_research/omnigent/web/src/shell/NewChatDialog.tsx")
text = path.read_text(encoding="utf-8")
old = '''/**
 * Return true when ``workspace`` is acceptable to send to the backend.
 *
 * Per designs/SESSION_WORKSPACE_SELECTION.md: only fully-absolute
 * paths (starting with ``/``) are accepted. Tilde-prefixed and
 * relative paths are rejected because the server never expands ``~``
 * — that's the host's job, and the workspace request body must be
 * an unambiguous absolute path. Empty / whitespace-only input is
 * also rejected so the submit button is disabled until the user
 * has typed something usable.
 *
 * @param workspace Value the user typed in the workspace input.
 * @returns true when ``workspace.trim()`` starts with ``/``.
 */
export function isValidWorkspace(workspace: string): boolean {
  return workspace.trim().startsWith("/");
}
'''
new = '''/**
 * Return true when ``workspace`` is acceptable to send to the backend.
 *
 * Accept absolute host paths only:
 * - POSIX: starts with ``/``
 * - Windows drive: ``C:\\...`` or ``C:/...``
 * - Windows UNC: ``\\\\server\\share\\...``
 *
 * Tilde-prefixed and relative paths are rejected because the server never
 * expands ``~`` — the workspace body must be an unambiguous absolute path.
 * Empty / whitespace-only input is also rejected.
 *
 * @param workspace Value the user typed in the workspace input.
 * @returns true when the trimmed path is absolute on POSIX or Windows.
 */
export function isValidWorkspace(workspace: string): boolean {
  const trimmed = workspace.trim();
  if (!trimmed) return false;
  // POSIX absolute (and also the root "/")
  if (trimmed.startsWith("/")) return true;
  // Windows UNC \\\\server\\share
  if (trimmed.startsWith("\\\\\\\\") || trimmed.startsWith("//")) return true;
  // Windows drive letter: C:\\ or C:/
  if (/^[A-Za-z]:[\\\\/]/.test(trimmed)) return true;
  return false;
}
'''
# Fix the UNC check - in the source file we want actual backslashes
new = '''/**
 * Return true when ``workspace`` is acceptable to send to the backend.
 *
 * Accept absolute host paths only:
 * - POSIX: starts with ``/``
 * - Windows drive: ``C:\\...`` or ``C:/...``
 * - Windows UNC: ``\\\\server\\share\\...``
 *
 * Tilde-prefixed and relative paths are rejected because the server never
 * expands ``~`` — the workspace body must be an unambiguous absolute path.
 * Empty / whitespace-only input is also rejected.
 *
 * @param workspace Value the user typed in the workspace input.
 * @returns true when the trimmed path is absolute on POSIX or Windows.
 */
export function isValidWorkspace(workspace: string): boolean {
  const trimmed = workspace.trim();
  if (!trimmed) return false;
  // POSIX absolute (and also the root "/")
  if (trimmed.startsWith("/")) return true;
  // Windows UNC \\\\server\\share
  if (trimmed.startsWith("\\\\") || trimmed.startsWith("//")) return true;
  // Windows drive letter: C:\\ or C:/
  if (/^[A-Za-z]:[\\\\/]/.test(trimmed)) return true;
  return false;
}
'''
if old not in text:
    # try simpler replace of just the function body
    old2 = '''export function isValidWorkspace(workspace: string): boolean {
  return workspace.trim().startsWith("/");
}'''
    new2 = '''export function isValidWorkspace(workspace: string): boolean {
  const trimmed = workspace.trim();
  if (!trimmed) return false;
  // POSIX absolute (and also the root "/")
  if (trimmed.startsWith("/")) return true;
  // Windows UNC \\\\server\\share
  if (trimmed.startsWith("\\\\") || trimmed.startsWith("//")) return true;
  // Windows drive letter: C:\\ or C:/
  if (/^[A-Za-z]:[\\\\/]/.test(trimmed)) return true;
  return false;
}'''
    if old2 not in text:
        raise SystemExit("isValidWorkspace pattern not found")
    text = text.replace(old2, new2, 1)
    # update doc comment lightly
    text = text.replace(
        " * @returns true when ``workspace.trim()`` starts with ``/``.",
        " * @returns true when the trimmed path is absolute on POSIX or Windows.",
        1,
    )
else:
    text = text.replace(old, new, 1)

# Also improve normalizeWorkspacePath for Windows trailing backslashes
old_norm = '''export function normalizeWorkspacePath(path: string): string | null {
  const trimmed = path.trim();
  if (trimmed === "") return null;
  const stripped = trimmed.replace(/\\/+$/, "");
  // All-slashes input (e.g. "///") collapses to the root.
  return stripped === "" ? "/" : stripped;
}'''
new_norm = '''export function normalizeWorkspacePath(path: string): string | null {
  const trimmed = path.trim();
  if (trimmed === "") return null;
  // Strip trailing slashes / backslashes but keep drive root "C:\\" and POSIX "/".
  const stripped = trimmed.replace(/[\\\\/]+$/, "");
  if (stripped === "") return "/";
  // "C:" alone after stripping "C:\\" — restore drive root
  if (/^[A-Za-z]:$/.test(stripped)) return stripped + "\\\\";
  return stripped;
}'''
if old_norm in text:
    text = text.replace(old_norm, new_norm, 1)
    print("normalizeWorkspacePath updated")
else:
    print("normalizeWorkspacePath pattern skip")

path.write_text(text, encoding="utf-8")
print("patched NewChatDialog.tsx")

# --- tests ---
tpath = Path("/home/code/pravite_fund_ai_research/omnigent/web/src/shell/NewChatDialog.test.tsx")
tt = tpath.read_text(encoding="utf-8")
needle = '''  it("rejects relative paths", () => {
    expect(isValidWorkspace("projects/myapp")).toBe(false);
    expect(isValidWorkspace("./myapp")).toBe(false);
    expect(isValidWorkspace("../myapp")).toBe(false);
  });
'''
insert = '''  it("rejects relative paths", () => {
    expect(isValidWorkspace("projects/myapp")).toBe(false);
    expect(isValidWorkspace("./myapp")).toBe(false);
    expect(isValidWorkspace("../myapp")).toBe(false);
  });

  it("accepts Windows absolute paths", () => {
    expect(isValidWorkspace("C:\\\\Users\\\\me\\\\project")).toBe(true);
    expect(isValidWorkspace("c:/Users/me/project")).toBe(true);
    expect(isValidWorkspace("D:\\\\data")).toBe(true);
  });

  it("accepts Windows UNC paths", () => {
    expect(isValidWorkspace("\\\\\\\\server\\\\share\\\\repo")).toBe(true);
  });
'''
if "accepts Windows absolute paths" not in tt:
    if needle not in tt:
        raise SystemExit("test needle not found")
    tpath.write_text(tt.replace(needle, insert, 1), encoding="utf-8")
    print("patched NewChatDialog.test.tsx")
else:
    print("tests already have Windows cases")
