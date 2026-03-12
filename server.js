const express = require("express")
const sqlite3 = require("sqlite3").verbose()
const fs = require("fs")
const path = require("path")
const crypto = require("crypto")
const helmet = require("helmet")
const chokidar = require("chokidar")
const { Throttle } = require("stream-throttle")

const app = express()

app.set("view engine","ejs")
app.set("views",path.join(__dirname,"views"))

app.use(express.static("public"))
app.use(helmet())

// ================= DATABASE =================

app.use(express.static(path.join(__dirname, 'assets')))

const DB_FILE = path.join(__dirname,"db.sqlite")

if(!fs.existsSync(DB_FILE)){
console.log("Creating database")
}

const db = new sqlite3.Database(DB_FILE)

db.serialize(()=>{

db.run(`
CREATE TABLE IF NOT EXISTS files(
id INTEGER PRIMARY KEY AUTOINCREMENT,
name TEXT,
path TEXT UNIQUE,
size INTEGER,
sha256 TEXT,
downloads INTEGER DEFAULT 0
)
`)

db.run(`
CREATE TABLE IF NOT EXISTS tokens(
token TEXT PRIMARY KEY,
file_id INTEGER,
ip TEXT,
created INTEGER,
expire INTEGER,
used INTEGER DEFAULT 0
)
`)

db.run(`
CREATE TABLE IF NOT EXISTS logs(
id INTEGER PRIMARY KEY AUTOINCREMENT,
file_id INTEGER,
ip TEXT,
size INTEGER,
time DATETIME DEFAULT CURRENT_TIMESTAMP
)
`)

})

// ================= SETTINGS =================

const base = path.join(__dirname,"files")

const FILE_LIMIT = 50 * 1024 * 1024
const GLOBAL_LIMIT = 200 * 1024 * 1024

let active = 0

function globalSpeed(){
return GLOBAL_LIMIT / Math.max(active,1)
}

// ================= SHA256 =================

function sha256(file){

return new Promise((resolve,reject)=>{

const hash = crypto.createHash("sha256")
const stream = fs.createReadStream(file)

stream.on("data",d=>hash.update(d))
stream.on("end",()=>resolve(hash.digest("hex")))
stream.on("error",reject)

})

}

// ================= FILE SCAN =================

async function scan(dir){

const items = fs.readdirSync(dir)

for(const f of items){

const full = path.join(dir,f)
const stat = fs.statSync(full)

if(stat.isDirectory()){
await scan(full)
continue
}

const rel = path.relative(base,full).replace(/\\/g,"/")

db.get(
"SELECT id FROM files WHERE path=?",
[rel],
async (err,row)=>{

if(!row){

const hash = await sha256(full)

db.run(
"INSERT INTO files(name,path,size,sha256) VALUES(?,?,?,?)",
[f,rel,stat.size,hash]
)

}

})

}

}

if(fs.existsSync(base)){
scan(base)
}

// ================= WATCHER =================

const watcher = chokidar.watch(base,{ignoreInitial:true})

watcher.on("add",async filePath=>{

const stat = fs.statSync(filePath)

const rel = path.relative(base,filePath).replace(/\\/g,"/")
const name = path.basename(filePath)

const hash = await sha256(filePath)

db.run(
"INSERT OR IGNORE INTO files(name,path,size,sha256) VALUES(?,?,?,?)",
[name,rel,stat.size,hash]
)

console.log("📥 added",rel)

})

watcher.on("unlink",filePath=>{

const rel = path.relative(base,filePath).replace(/\\/g,"/")

db.run("DELETE FROM files WHERE path=?",[rel])

console.log("🗑 removed",rel)

})

watcher.on("change",async filePath=>{

const stat = fs.statSync(filePath)

const rel = path.relative(base,filePath).replace(/\\/g,"/")

const hash = await sha256(filePath)

db.run(
"UPDATE files SET size=?,sha256=? WHERE path=?",
[stat.size,hash,rel]
)

console.log("♻ updated",rel)

})

// ================= INDEX =================

app.get("/",(req,res)=>{

const folders = fs.readdirSync(base).filter(f=>{
return fs.statSync(path.join(base,f)).isDirectory()
})

res.render("index",{folders})

})

// ================= FOLDER =================

const iconDir = path.join(__dirname, "assets")

app.get("/:folder",(req,res)=>{

const folder = req.params.folder

db.all(
"SELECT * FROM files WHERE path LIKE ?",
[folder + "/%"],
(err,files)=>{

res.render("folder_"+folder,{
files,
folder,
fs,
iconDir
})

})

})

// ================= FILE PAGE =================

app.get("/file/:id",(req,res)=>{

db.get(
"SELECT * FROM files WHERE id=?",
[req.params.id],
(err,file)=>{

if(!file) return res.send("File not found")

res.render("file",{file})

})

})

// ================= TOKEN =================

app.get("/file/:id/download",(req,res)=>{

const id = req.params.id
const ip = req.ip

db.get(
`SELECT COUNT(*) as c
FROM logs
WHERE ip=? AND time > datetime('now','-1 hour')`,
[ip],
(err,row)=>{

if(row.c >= 10)
return res.send("Hourly download limit reached")

const token = crypto.randomBytes(8).toString("hex")

const now = Math.floor(Date.now()/1000)

db.run(
"INSERT INTO tokens(token,file_id,ip,created,expire) VALUES(?,?,?,?,?)",
[token,id,ip,now,300],
()=>{

res.redirect("/dl/"+token)

})

})

})

// ================= DOWNLOAD =================

app.get("/dl/:token",(req,res)=>{

const token = req.params.token
const ip = req.ip

db.get(
"SELECT * FROM tokens WHERE token=?",
[token],
(err,row)=>{

if(!row) return res.send("Invalid token")
if(row.used) return res.send("Token used")
if(row.ip !== ip) return res.send("IP mismatch")

const now = Math.floor(Date.now()/1000)

if(now - row.created > row.expire)
return res.send("Token expired")

db.get(
"SELECT * FROM files WHERE id=?",
[row.file_id],
(err,file)=>{

if(!file) return res.send("File missing")

const filePath = path.join(base,file.path)

if(!fs.existsSync(filePath))
return res.send("File missing")

db.run(
"INSERT INTO logs(file_id,ip,size) VALUES(?,?,?)",
[file.id,ip,file.size]
)

db.run(
"UPDATE files SET downloads=downloads+1 WHERE id=?",
[file.id]
)

db.run(
"UPDATE tokens SET used=1 WHERE token=?",
[token]
)

active++

const stream = fs.createReadStream(filePath)

const throttle = new Throttle({
rate: Math.min(FILE_LIMIT,globalSpeed())
})

res.setHeader(
"Content-Disposition",
'attachment; filename="'+file.name+'"'
)

stream
.pipe(throttle)
.pipe(res)
.on("finish",()=>{

active--

})

})

})

})

// ================= STATS =================

app.get("/stats",(req,res)=>{

db.all(
"SELECT * FROM files ORDER BY downloads DESC",
[],
(err,files)=>{

db.all(
"SELECT * FROM logs ORDER BY time DESC LIMIT 100",
[],
(err2,logs)=>{

res.render("stats",{files,logs})

})

})

})

// ================= START =================

app.listen(3000,()=>{

console.log("app running on http://localhost:3000")

})