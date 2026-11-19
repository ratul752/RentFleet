'use strict';
// Browser always calls same-origin /api. The frontend proxy forwards requests to a separately deployed API.
function respond(res,status,error){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({error}));}
async function proxy(req,res){try{
 const original=new URL(req.url,'http://localhost');const rewritten=original.searchParams.get('__rf_path');if(rewritten!==null){if(!/^[a-zA-Z0-9_\/-]+$/.test(rewritten))return respond(res,400,'Invalid API path');original.pathname='/api/'+rewritten.replace(/^\/+/, '');original.searchParams.delete('__rf_path');}
 if(!original.pathname.startsWith('/api/')||original.pathname.includes('..'))return respond(res,404,'Not found');
 if(!['GET','HEAD','POST','PATCH','PUT','DELETE'].includes(req.method))return respond(res,405,'Method not allowed');
 const rawBase=process.env.PUBLIC_API_BASE_URL||(process.env.VERCEL?'':'http://localhost:5000');if(!rawBase)return respond(res,503,'Backend URL is not configured');const backend=new URL(rawBase);if(!['http:','https:'].includes(backend.protocol)||backend.username||backend.password||backend.pathname!=='/'||backend.search||backend.hash)return respond(res,503,'Invalid backend origin');if(process.env.VERCEL&&backend.protocol!=='https:')return respond(res,503,'Backend must use HTTPS');
 // On production, set the backend to allow the actual client origin, not '*'.
 const proto=process.env.VERCEL?'https':'http';const origin=proto+'://'+req.headers.host;const sentOrigin=req.headers.origin;if(sentOrigin&&sentOrigin!==origin)return respond(res,403,'Cross-site request rejected');
 if(req.headers['sec-fetch-site']==='cross-site')return respond(res,403,'Cross-site request rejected');
 const headers={'accept':req.headers.accept||'application/json','origin':origin};if(req.headers.cookie)headers.cookie=req.headers.cookie;if(req.headers['content-type'])headers['content-type']=req.headers['content-type'];
 let body;if(!['GET','HEAD'].includes(req.method)){if(req.body!==undefined){body=Buffer.isBuffer(req.body)||typeof req.body==='string'?req.body:JSON.stringify(req.body);if(body&&!headers['content-type'])headers['content-type']='application/json';}else{let size=0;const chunks=[];for await(const c of req){const b=Buffer.from(c);size+=b.length;if(size>1048576)return respond(res,413,'Request too large');chunks.push(b);}body=Buffer.concat(chunks);}if(body&&Buffer.byteLength(body)>1048576)return respond(res,413,'Request too large');if(!body?.length)body=undefined;}
 const target=new URL(original.pathname+original.search,backend.origin);const result=await fetch(target,{method:req.method,headers,body,redirect:'manual',signal:AbortSignal.timeout(55000)});
 for(const key of ['content-type','content-disposition','cache-control','x-content-type-options']){const val=result.headers.get(key);if(val)res.setHeader(key,val);}const cookies=result.headers.getSetCookie();if(cookies.length)res.setHeader('Set-Cookie',cookies);res.statusCode=result.status;res.end(Buffer.from(await result.arrayBuffer()));
 }catch(e){console.error('RentFleet proxy error:',e.name);if(!res.headersSent)respond(res,502,'Cannot connect to RentFleet backend');else res.end();}}
module.exports=proxy;
