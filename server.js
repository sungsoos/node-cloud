const express = require("express")
const fs = require("fs")
const path = require("path")
const crypto = require("crypto")

const app = express()

const PORT = 3000
const BASE = path.join(__dirname,"files")

app.set("view engine","ejs")
app.set("views",path.join(__dirname,"views"))

app.use(express.static(path.join(__dirname, "assets")))

const downloads = []

function createToken(){

    return crypto.randomBytes(6).toString("base64url")

}

function formatSize(bytes){

    if(bytes > 1024*1024*1024) return (bytes/1024/1024/1024).toFixed(2)+" GB"
    if(bytes > 1024*1024) return (bytes/1024/1024).toFixed(2)+" MB"
    if(bytes > 1024) return (bytes/1024).toFixed(2)+" KB"

    return bytes+" B"

}

function listDir(dir){

    const items = fs.readdirSync(dir)

    const folders = []
    const files = []

    items.forEach(name=>{

        const full = path.join(dir,name)
        const stat = fs.statSync(full)

        if(stat.isDirectory()){

            folders.push({
                name
            })

        }else{

            files.push({
                name,
                size:stat.size,
                sizeHuman:formatSize(stat.size)
            })

        }

    })

    folders.sort((a,b)=>a.name.localeCompare(b.name))
    files.sort((a,b)=>a.name.localeCompare(b.name))

    return {folders,files}

}

function chooseTemplate(parts){

    if(!parts.length) return "folder"

    const root = parts[0]

    const custom = "folder_"+root
    const viewPath = path.join(__dirname,"views",custom+".ejs")

    if(fs.existsSync(viewPath)) return custom

    return "folder"

}

function renderFolder(req,res,rel){

    const safeRel = path.normalize(rel).replace(/\.\./g,"")
    const full = path.join(BASE, safeRel)
    
    console.log("URL:", rel)
    console.log("BASE:", BASE)
    console.log("FULL:", full)
    console.log("EXISTS:", fs.existsSync(full))

    if(!full.startsWith(BASE)){
        return res.status(403).send("forbidden")
    }

    if(!fs.existsSync(full)){
        return res.status(404).send("not found")
    }

    const stat = fs.statSync(full)

    if(stat.isFile()){

        const token = createToken()

        downloads.push({

            token,
            file:rel,
            ip:req.ip,
            created:Date.now(),
            expire:60000,
            used:false

        })

        return res.redirect("/download/"+token)

    }

    const {folders,files} = listDir(full)

    const parts = rel ? rel.split("/") : []

    const view = chooseTemplate(parts)

    res.render(view,{
        folder:rel,
        parts,
        folders,
        files,
        fs
    })

}

app.get("/",(req,res)=>{

    renderFolder(req,res,"")

})

app.get("/download/:token",(req,res)=>{

    const token = req.params.token

    const entry = downloads.find(t=>t.token===token)

    if(!entry) return res.send("token invalid")

    if(entry.used) return res.send("token used")

    if(Date.now() > entry.created + entry.expire){

        return res.send("token expired")

    }

    const full = path.join(BASE,entry.file)

    if(!fs.existsSync(full)) return res.send("file missing")

    entry.used = true

    res.download(full)

})

app.get("/stats",(req,res)=>{
    res.json(downloads)
})

app.use((req,res)=>{
    const rel = decodeURIComponent(req.path).replace(/^\/+/,"")
    renderFolder(req,res,rel)
})

app.listen(PORT,()=>{

    console.log("server running on "+PORT)

})