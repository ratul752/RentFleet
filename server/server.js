'use strict';
require('./env.cjs');
const http=require('node:http');
const repo=require('./repository');
const {route,sendError,passwordHash,password,email,required}=require('./routes');
let ready;
async function initialize(){if(!ready)ready=(async()=>{await repo.connect();if(!(await repo.count('users'))){const em=process.env.OWNER_EMAIL,pw=process.env.OWNER_PASSWORD;if(em||pw||process.env.NODE_ENV==='production'){if(!em||!pw)throw Error('Configure OWNER_EMAIL and OWNER_PASSWORD before deployment');const hash=passwordHash(password(pw));await repo.atomic(async()=>{if(!(await repo.count('users')))await repo.insert('users',{full_name:required(process.env.OWNER_NAME||'Fleet Owner','Owner name'),email:email(em),pass_hash:hash,role:'owner'});});}}})();try{await ready;}catch(e){ready=undefined;throw e;}}
function error(message,status){const e=Error(message);e.status=status;throw e;}
const allowed=()=>new Set((process.env.CLIENT_ORIGINS||'http://localhost:5173,http://127.0.0.1:5173').split(',').map(x=>x.trim().replace(/\/+$/,'')).filter(Boolean));
async function parseBody(req){if(['GET','HEAD','OPTIONS'].includes(req.method))return {};let raw=req.body;if(raw===undefined){const parts=[];let size=0;for await(const c of req){const b=Buffer.from(c);size+=b.length;if(size>1024*1024)error('Request is too large',413);parts.push(b);}raw=Buffer.concat(parts);}else if(!Buffer.isBuffer(raw)&&typeof raw!=='string'){if(Buffer.byteLength(JSON.stringify(raw))>1024*1024)error('Request is too large',413);if(!raw||typeof raw!=='object'||Array.isArray(raw))error('Invalid JSON body',400);return raw;}if(Buffer.byteLength(raw)>1024*1024)error('Request is too large',413);if(!raw.length)return {};try{const b=JSON.parse(raw.toString());if(!b||typeof b!=='object'||Array.isArray(b))error('Invalid JSON body',400);return b;}catch(e){error('Invalid JSON body',400);}}
// Do not send successful replies or cookies until transaction commit has succeeded.
function buffered(){const headers={};let status=200,data='';return {setHeader(k,v){headers[k]=v;},writeHead(s,h){status=s;Object.assign(headers,h);return this;},end(value=''){data=value;return this;},flush(res){res.writeHead(status,headers);res.end(data);}};}
async function handler(req,res){try{
 const parsed=new URL(req.url,'http://localhost');if(!parsed.pathname.startsWith('/api/'))error('Not found',404);
 const origin=req.headers.origin;if(origin){if(!allowed().has(origin))error('Cross-site request rejected',403);res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Access-Control-Allow-Credentials','true');res.setHeader('Vary','Origin');}
 if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Methods':'GET,POST,PATCH,PUT,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'600'});return res.end();}
 if(!['GET','HEAD','POST','PATCH','PUT','DELETE'].includes(req.method))error('Method not allowed',405);
 req.parsedBody=await parseBody(req);await initialize();
 if(req.method==='POST'&&['/api/login','/api/customer/login','/api/customer/signup','/api/customer/password'].includes(parsed.pathname)){const identity=parsed.pathname.endsWith('/password')?(req.headers.cookie||'anonymous'):String(req.parsedBody.email||'').trim().slice(0,254).toLowerCase();await repo.throttle(parsed.pathname+':'+identity);}
 if(['GET','HEAD'].includes(req.method))return await route(req,res);
 const result=await repo.atomic(async()=>{const out=buffered();await route(req,out);return out;});result.flush(res);
 }catch(e){if(!res.headersSent)sendError(res,e);else res.end();}}
function startServer(){const port=Number(process.env.PORT||5000),host=process.env.HOST||'127.0.0.1';const server=http.createServer(handler);return initialize().then(()=>{server.listen(port,host,()=>console.log(`RentFleet API: http://${host}:${port}`));return server;});}
if(require.main===module)startServer().catch(e=>{console.error('Startup failed:',e.message);process.exitCode=1;});
module.exports=handler;module.exports.startServer=startServer;
