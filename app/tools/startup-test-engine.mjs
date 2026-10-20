// Minimal event-driven engine boundary for startup UI tests. Never opens audio.
import readline from 'node:readline'
let announced = false
const send = value => process.stdout.write(JSON.stringify(value)+'\n')
const input = readline.createInterface({input:process.stdin})
input.on('line',line=>{
  const {id,cmd}=JSON.parse(line)
  const ok = data => send({id,ok:true,data})
  switch(cmd){
    case 'hello':
      ok({protocol:1,version:'startup-test',capabilities:{exclusive:false,shared:false,resampler:false,dsp:false,queue:false,seek:false}})
      if(!announced){announced=true;send({ev:'ready',protocol:1,version:'startup-test',devices:[]})}
      break
    case 'get_state': ok({ev:'state',state:'stopped',trackId:'',outputMode:'none',sampleRate:0,bitDepth:0,bitPerfect:false});break
    case 'list_tracks':ok({tracks:[]});break
    case 'list_devices':ok({devices:[]});break
    case 'shutdown':ok({});process.exit(0);break
    default:send({id,ok:false,error:{code:'ERR_UNSUPPORTED',message:'Not needed by startup test: '+cmd}})
  }
})
input.on('close',()=>process.exit(0))
