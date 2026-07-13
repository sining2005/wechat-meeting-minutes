import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root=path.resolve(import.meta.dirname,"..");
const errors=[];
function walk(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,item.name);if(item.isDirectory()&&item.name!=="node_modules")walk(file);else if(item.isFile()&&file.endsWith(".json")){try{JSON.parse(fs.readFileSync(file,"utf8"));}catch(e){errors.push(`JSON错误 ${path.relative(root,file)}: ${e.message}`);}}}}
walk(root);
for(const file of ["cloudfunctions/api/index.js","cloudfunctions/processor/index.js","cloudfunctions/setup/index.js"]){try{execFileSync(process.execPath,["--check",path.join(root,file)],{stdio:"pipe"});}catch(e){errors.push(`JavaScript语法错误 ${file}: ${e.stderr?.toString()||e.message}`);}}
const project=JSON.parse(fs.readFileSync(path.join(root,"project.config.json"),"utf8"));
const app=fs.readFileSync(path.join(root,"miniprogram/app.ts"),"utf8");
if(!/^wx[0-9a-f]{16}$/.test(project.appid))errors.push("project.config.json 中的 AppID 无效");
if(!app.includes("cloud1-d1gn26yde8fd1f267"))errors.push("app.ts 尚未写入正确云环境ID");
for(const required of ["meetings","audioSegments","processingJobs","providerConfigs","invitedUsers"]){if(!fs.readFileSync(path.join(root,"cloudfunctions/setup/index.js"),"utf8").includes(required))errors.push(`初始化函数缺少集合 ${required}`);}
if(errors.length){console.error(errors.join("\n"));process.exit(1);}console.log("预检通过：JSON、云函数语法、AppID、云环境ID和集合定义均有效。");
