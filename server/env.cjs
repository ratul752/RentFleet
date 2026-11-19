'use strict';
const path=require('node:path');
try{process.loadEnvFile(path.join(__dirname,'.env'));}catch(e){if(e.code!=='ENOENT')throw e;}
// Same Windows-only SRV DNS fix as Oravel. Disable with MONGO_DNS_FIX=false.
if(process.platform==='win32'&&process.env.MONGO_DNS_FIX!=='false'){
 require('node:dns').setServers(['8.8.8.8','1.1.1.1']);
 require('node:dns/promises').setServers(['8.8.8.8','1.1.1.1']);
}
