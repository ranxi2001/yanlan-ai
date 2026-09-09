import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("TextGrid references preserve speaker identity, timing, quotes and overlap", (t) => {
  const code = `import importlib.util,json
spec=importlib.util.spec_from_file_location('meeting','scripts/prepare-hf-meeting-benchmark.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
text='''item [1]:
    class = "IntervalTier"
    name = "S1"
    intervals [1]:
        xmin = 0.5
        xmax = 2.0
        text = "He said ""yes"""
    intervals [2]:
        xmin = 2.0
        xmax = 3.0
        text = ""
item [2]:
    class = "IntervalTier"
    name = "S2"
    intervals [1]:
        xmin = 1.0
        xmax = 2.5
        text = "another speaker"
'''
print(json.dumps(m.parse_textgrid(text)))`;
  const result = spawnSync("python", ["-B", "-c", code], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (result.error?.code === "ENOENT") { t.skip("Python is not installed"); return; }
  assert.equal(result.status, 0, result.stderr);
  const rows = JSON.parse(result.stdout);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].speaker, "S1");
  assert.equal(rows[0].text, 'He said "yes"');
  assert.equal(rows[1].start_seconds, 1);
  assert.ok(rows[0].end_seconds > rows[1].start_seconds);
});

test("long-form clean spans exclude complete overlapping utterances and retain real silence", (t) => {
  const code = `import importlib.util,json
spec=importlib.util.spec_from_file_location('longform','scripts/prepare-hf-longform.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
rows=[
 {'speaker':'A','start_seconds':0,'end_seconds':70,'text':'first'},
 {'speaker':'B','start_seconds':50,'end_seconds':60,'text':'overlap'},
 {'speaker':'A','start_seconds':80,'end_seconds':110,'text':'clean one'},
 {'speaker':'A','start_seconds':140,'end_seconds':170,'text':'clean two'},
 {'speaker':'A','start_seconds':175,'end_seconds':180,'text':'<noise>'},
]
print(json.dumps(m.clean_spans(rows,180)))`;
  const result=spawnSync("python",["-B","-c",code],{encoding:"utf8",windowsHide:true,timeout:10000});
  if(result.error?.code==="ENOENT"){t.skip("Python is not installed");return;}
  assert.equal(result.status,0,result.stderr);
  const spans=JSON.parse(result.stdout);assert.equal(spans.length,1);
  assert.equal(spans[0][0],79.95);assert.equal(spans[0][1],170.05);
  assert.deepEqual(spans[0][2].map(r=>r.text),['clean one','clean two']);
});
