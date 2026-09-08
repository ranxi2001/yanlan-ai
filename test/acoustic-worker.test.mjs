import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("optional worker maps Chinese and UTF-16 spans without inventing times for unaligned words", (t) => {
  const code = `import importlib.util,json
spec=importlib.util.spec_from_file_location('worker','scripts/align-transcript.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
good=m.map_words('你好，GPU。',[{'word':'你好','start':0,'end':1},{'word':'GPU','start':1,'end':2}])
missing=m.map_words('你好GPU',[{'word':'你好','start':0,'end':1},{'word':'GPU'}])
emoji=m.map_words('😀你好。',[{'word':'你好','start':0,'end':1}])
print(json.dumps({'good':good,'missing':missing,'emoji':emoji},ensure_ascii=True))`;
  const result = spawnSync("python", ["-B", "-c", code], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  if (result.error?.code === "ENOENT") { t.skip("Optional Python worker is not installed"); return; }
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed.good.map((word) => [word.start_offset, word.end_offset]), [[0, 3], [3, 7]]);
  assert.deepEqual(parsed.missing, []);
  assert.equal(parsed.emoji[0].end_offset, 5);
  assert.equal(parsed.emoji[0].text, "😀你好。");
});
