import WebSocket from 'ws'
const ws=new WebSocket('ws://127.0.0.1:8123/ws')
await new Promise(r=>ws.on('open',r))
const res=await new Promise(r=>{
  ws.on('message',m=>r('ANTWORT: '+m.toString().slice(0,90)))
  setTimeout(()=>r('KEINE ANTWORT (client haengt)'),2500)
  ws.send(JSON.stringify({type:'login',payload:{name:'Basti',roomCode:'2LKE'}}))
})
console.log(res); process.exit(0)
