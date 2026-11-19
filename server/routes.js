'use strict';
const crypto=require('node:crypto');
const repo=require('./repository');
const SESSION_MS=14*24*60*60*1000;
const transaction=async work=>work(); // outer request transaction handles retries and commit
function err(message,status=400){const e=new Error(message);e.status=status;throw e;}
function need(b,message,status=400){if(!b)err(message,status);}
function s(v, max=200){return String(v??'').trim().slice(0,max);}
function required(v,label,max=160){const a=s(v,max);need(a.length>0,`${label} is required`);return a;}
function num(v,label,min=0,max=1000000000){const n=Number(v);need(v!==''&&v!=null&&Number.isFinite(n)&&n>=min&&n<=max,`${label} must be between ${min} and ${max}`);return Math.round(n*100)/100;}
function int(v,label,min=0,max=1000000000){const n=Number(v);need(Number.isSafeInteger(n)&&n>=min&&n<=max,`${label} must be a whole number between ${min} and ${max}`);return n;}
function date(v,label){const d=s(v,10);need(/^\d{4}-\d{2}-\d{2}$/.test(d)&&!Number.isNaN(Date.parse(d+'T00:00:00Z'))&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d,`${label} must be YYYY-MM-DD`);return d;}
function isoDay(d=new Date()){return d.toISOString().slice(0,10);}
function daysBetween(a,b){return Math.round((Date.parse(b+'T00:00:00Z')-Date.parse(a+'T00:00:00Z'))/86400000);}
function passwordHash(password){const salt=crypto.randomBytes(16).toString('hex');const hash=crypto.scryptSync(password,salt,64).toString('hex');return `${salt}:${hash}`;}
function verifyPassword(password,stored){const [salt,hex]=stored.split(':');if(!salt||!hex)return false;const hash=crypto.scryptSync(password,salt,64);const comparison=Buffer.from(hex,'hex');return hash.length===comparison.length&&crypto.timingSafeEqual(hash,comparison);}
function password(v){need(typeof v==='string'&&v.length>=10&&v.length<=128,'Password must have 10 to 128 characters');return v;}
function email(v){const em=required(v,'Email',254).toLowerCase();need(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em),'Enter a valid email');return em;}
function id(v){return int(v,'ID',1);}
async function audit(user,action,target,targetId,details=''){(await repo.insert('audit',repo.record(["user_id","action","target","target_id","details"],[user?.id||null,action,target,targetId,String(details).slice(0,500)])));}
function userSafe(u){return {id:u.id,name:u.full_name,email:u.email,role:u.role,active:!!u.active};}
async function auth(req){const match=/(?:^|;\s*)rf_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||'');if(!match)return null;const hash=crypto.createHash('sha256').update(match[1]).digest('hex');const u=(await repo.adminSession(hash,Date.now()));return u||null;}
async function issueSession(req,res,u){const token=crypto.randomBytes(32).toString('hex');(await repo.insert('sessions',repo.record(["token_hash","user_id","expires_at"],[crypto.createHash('sha256').update(token).digest('hex'),u.id,Date.now()+SESSION_MS])));const secure=process.env.NODE_ENV==='production'||Boolean(req.socket?.encrypted);res.setHeader('Set-Cookie',`rf_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS/1000}${secure?'; Secure':''}`);}
async function clearSession(req,res){const match=/(?:^|;\s*)rf_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||'');if(match)(await repo.remove('sessions',{token_hash:crypto.createHash('sha256').update(match[1]).digest('hex')}));res.setHeader('Set-Cookie','rf_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'+(process.env.NODE_ENV==='production'?'; Secure':''));}
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));}
function sendError(res,e){const status=e.status||(e.code===11000?409:500);if(status>=500)console.error('RentFleet API error:',e.name,e.code||'');json(res,status,{error:status>=500?'Server error. Check backend logs.':e.code===11000?'A record with this value already exists':e.message});}
async function body(req){return req.parsedBody||{};}
function normalizeRole(role){const r=s(role);need(['staff','admin'].includes(r),'Role must be staff or admin');return r;}
function requireManager(u){if(!['owner','admin'].includes(u.role))err('Manager permission required',403);}
function requireOwner(u){if(u.role!=='owner')err('Owner permission required',403);}
function vehicleForm(b,prev){const registration=required(b.registration??prev?.registration,'Registration',32).toUpperCase();const make=required(b.make??prev?.make,'Make',80);const model=required(b.model??prev?.model,'Model',80);const year=int(b.year??prev?.year,'Year',1980,2100);const category=required(b.category??prev?.category,'Category',50);const daily_rate=num(b.daily_rate??prev?.daily_rate,'Daily rate');const odometer=int(b.odometer??prev?.odometer??0,'Odometer');if(prev)need(odometer>=prev.odometer,'Odometer cannot decrease');const status=s(b.status??prev?.status??'available');need(['available','out_of_service'].includes(status),'Invalid availability status');const notes=s(b.notes??prev?.notes,1000);return{registration,make,model,year,category,daily_rate,odometer,status,notes};}
function photoFields(b){
  if(!Object.prototype.hasOwnProperty.call(b,'photo_data'))return {};
  if(b.photo_data==='')return {photo_data:'',has_image:false};
  const value=b.photo_data;
  need(typeof value==='string'&&value.length<=330000,'Vehicle photo must be at most 240 KB');
  const match=/^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  need(match,'Upload a valid JPEG vehicle photo');
  const bytes=Buffer.from(match[1],'base64');
  need(bytes.length>=4&&bytes.length<=240*1024&&bytes.toString('base64')===match[1]&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255&&bytes[bytes.length-2]===255&&bytes[bytes.length-1]===217,'Invalid JPEG or photo exceeds 240 KB');
  return {photo_data:value,has_image:true};
}
function customerForm(b,prev){return{name:required(b.name??prev?.name,'Customer name',160),phone:required(b.phone??prev?.phone,'Phone',40),email:s(b.email??prev?.email,254),license:s(b.license??prev?.license,120),address:s(b.address??prev?.address,300)};}
async function bookingRows(){return (await repo.bookingRows());}
async function bookingRow(bookingId){return (await repo.bookingRow(bookingId));}
async function availability(vehicleId,start,end,exceptBookingId=0){const conflict=(await repo.one('bookings',{vehicle_id:vehicleId,status:{$in:['reserved','active']},id:{$ne:exceptBookingId},start_date:{$lt:end},end_date:{$gt:start}}));return conflict;}
async function inService(vehicleId){return Boolean((await repo.one('maintenance',{vehicle_id:vehicleId,status:'in_progress'})));}
async function dashboard(){const vehicles=await repo.list('vehicles',{}, {id:-1});const bookings=await repo.bookingRows();const customers=await repo.count('customers');const today=isoDay();const rentals=bookings.filter(b=>b.status==='active');const reserved=bookings.filter(b=>b.status==='reserved');const serviceIds=new Set((await repo.list('maintenance',{status:'in_progress'})).map(m=>m.vehicle_id));const available=vehicles.filter(v=>v.status==='available'&&!rentals.some(b=>b.vehicle_id===v.id)&&!serviceIds.has(v.id)).length;const month=today.slice(0,7);const payments=await repo.list('payments');const sumMonth=key=>payments.filter(p=>p.paid_at.startsWith(key)).reduce((sum,p)=>sum+p.amount,0);const outstanding=bookings.filter(b=>b.status!=='cancelled').reduce((sum,b)=>sum+Math.max(0,b.base_amount+b.extra_charges-b.paid),0);const maintenance=await repo.count('maintenance',{status:{$ne:'done'}});const series=[];for(let i=5;i>=0;i--){const d=new Date(Date.UTC(Number(today.slice(0,4)),Number(today.slice(5,7))-1-i,1));const key=d.toISOString().slice(0,7);series.push({month:key,revenue:sumMonth(key)});}return{vehicles:vehicles.length,available,on_rent:rentals.length,upcoming:reserved.length,customers,revenue_month:sumMonth(month),outstanding,maintenance_open:maintenance,series,recent:bookings.slice(0,8),active:rentals.slice(0,5)};}
async function updateFields(table,key,record,allowed){const cols=Object.keys(record).filter(k=>allowed.includes(k));need(cols.length>0,'Nothing to update');await repo.update(table,{id:key},Object.fromEntries(cols.map(k=>[k,record[k]])));}
function valueSet(b,prev,field,fn){return fn(b[field]??prev?.[field]);}
async function setConfig(key,val){(await repo.upsertSetting(key,JSON.stringify(val)));}
async function getConfig(){const rows=(await repo.list('settings',{},{}));const obj={company:'RentFleet Pro',currency:'BDT',phone:'',address:''};for(const row of rows){try{obj[row.key]=JSON.parse(row.value);}catch{}}return obj;}
function customerCookie(req){return /(?:^|;\s*)rf_customer=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||'')?.[1];}
function tokenHash(token){return crypto.createHash('sha256').update(token).digest('hex');}
function customerCookieFlags(req){return `HttpOnly; SameSite=Strict; Path=/;${process.env.NODE_ENV==='production'||Boolean(req.socket?.encrypted)?' Secure;':''}`;}
async function customerAuth(req){const token=customerCookie(req);if(!token)return null;return (await repo.customerAuth(tokenHash(token),Date.now()))||null;}
async function customerSession(req,res,accountId){const token=crypto.randomBytes(32).toString('hex');const old=customerCookie(req);if(old)(await repo.remove('customer_sessions',{token_hash:tokenHash(old)}));(await repo.remove('customer_sessions',{expires_at:{$lte:Date.now()}}));(await repo.insert('customer_sessions',repo.record(["token_hash","account_id","expires_at"],[tokenHash(token),accountId,Date.now()+SESSION_MS])));res.setHeader('Set-Cookie',`rf_customer=${token}; ${customerCookieFlags(req)} Max-Age=${SESSION_MS/1000}`);}
function publicCustomer(c){return {id:c.id,name:c.name,email:c.email,phone:c.phone,address:c.address};}
async function customerBookings(cid){return (await repo.customerBookings(cid));}
function publicDates(start,end){const a=date(start,'Pickup date'),z=date(end,'Return date');const days=daysBetween(a,z);need(a>=isoDay(),'Pickup date cannot be in the past');need(days>=1&&days<=365,'Rental must be 1 to 365 days');return {start:a,end:z,days};}
async function customerRoute(req,res,url,parts){
  const method=req.method, resource=parts[2], ident=parts[3], action=parts[4];
  if(method==='GET'&&resource==='info'&&!ident){const c=(await getConfig());return json(res,200,{company:c.company,currency:c.currency,phone:c.phone,address:c.address});}
  if(method==='GET'&&resource==='vehicles'&&ident&&action==='image'&&parts.length===5){
    const v=await repo.vehiclePhoto(id(ident));
    if(!v?.photo_data)err('Vehicle photo not found',404);
    const photo=photoFields({photo_data:v.photo_data}).photo_data;
    res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    return res.end(Buffer.from(photo.slice('data:image/jpeg;base64,'.length),'base64'));
  }
  if(method==='GET'&&resource==='vehicles'&&!ident){
    const start=url.searchParams.get('start'),end=url.searchParams.get('end');let dates=null;if(start!==null||end!==null)dates=publicDates(start,end);
    const candidates=await repo.list('vehicles',{status:'available'},{id:-1});const vehicles=[];for(const v of candidates){if(await inService(v.id))continue;if(dates&&((await availability(v.id,dates.start,dates.end))||(await repo.one('bookings',{vehicle_id:v.id,status:'active',end_date:{$lte:isoDay()}}))))continue;const {id,make,model,year,category,daily_rate}=v;vehicles.push({id,make,model,year,category,daily_rate,has_image:!!v.has_image});}
    return json(res,200,{items:vehicles,currency:(await getConfig()).currency});
  }
  if(method==='POST'&&resource==='signup'&&!ident){
    const b=await body(req),em=email(b.email),pw=password(b.password),name=required(b.name,'Name'),phone=required(b.phone,'Phone',40),address=s(b.address,300);
    return transaction(async ()=>{if((await repo.one('customer_accounts',{email:em})))err('Account already exists. Please sign in.',409);
      const c=(await repo.insert('customers',repo.record(["name","phone","email","address"],[name,phone,em,address])));
      const a=(await repo.insert('customer_accounts',repo.record(["customer_id","email","pass_hash"],[c.id,em,passwordHash(pw)])));
      const uid=a.id;(await customerSession(req,res,uid));(await audit(null,'customer_signup','customer',c.id));return json(res,201,{user:{id:uid,name,email:em,phone,address}});});
  }
  if(method==='POST'&&resource==='login'&&!ident){
    const b=await body(req),em=email(b.email);const a=(await repo.customerByEmail(em));
    if(!a||typeof b.password!=='string'||b.password.length>128||!verifyPassword(b.password,a.pass_hash)){err('Invalid email or password',401);}(await customerSession(req,res,a.id));return json(res,200,{user:publicCustomer(a)});
  }
  if(method==='POST'&&resource==='logout'&&!ident){const token=customerCookie(req);if(token)(await repo.remove('customer_sessions',{token_hash:tokenHash(token)}));res.setHeader('Set-Cookie',`rf_customer=; ${customerCookieFlags(req)} Max-Age=0`);return json(res,200,{ok:true});}
  const c=(await customerAuth(req));if(!c)err('Please sign in to your customer account',401);
  if(method==='GET'&&resource==='me'&&!ident)return json(res,200,{user:publicCustomer(c)});
  if(method==='PATCH'&&resource==='me'&&!ident){const b=await body(req),name=required(b.name??c.name,'Name'),phone=required(b.phone??c.phone,'Phone',40),address=s(b.address??c.address,300);(await repo.update('customers',{id:c.customer_id},{name:name,phone:phone,address:address}));return json(res,200,{user:publicCustomer({...c,name,phone,address})});}
  if(method==='POST'&&resource==='password'&&!ident){const b=await body(req);const a=(await repo.one('customer_accounts',{id:c.id}));if(typeof b.current_password!=='string'||b.current_password.length>128||!verifyPassword(b.current_password,a.pass_hash)){err('Current password is incorrect',401);}const pw=password(b.password);return transaction(async ()=>{(await repo.update('customer_accounts',{id:c.id},{pass_hash:passwordHash(pw)}));(await repo.remove('customer_sessions',{account_id:c.id}));(await customerSession(req,res,c.id));return json(res,200,{ok:true});});}
  if(method==='GET'&&resource==='bookings'&&!ident)return json(res,200,{items:(await customerBookings(c.customer_id)),currency:(await getConfig()).currency});
  if(method==='POST'&&resource==='bookings'&&!ident){const b=await body(req);const d=publicDates(b.start_date,b.end_date),vid=id(b.vehicle_id);return transaction(async ()=>{const v=(await repo.one('vehicles',{id:vid}));need(v&&v.status==='available','Vehicle is unavailable',409);need(!(await inService(vid)),'Vehicle is undergoing maintenance',409);need(!(await availability(vid,d.start,d.end)),'Vehicle is already booked for these dates',409);need(!(await repo.one('bookings',{vehicle_id:vid,status:'active',end_date:{$lte:isoDay()}})),'Vehicle return is overdue',409);const rate=v.daily_rate,base=Math.round(rate*d.days*100)/100;const r=(await repo.insert('bookings',repo.record(["vehicle_id","customer_id","start_date","end_date","status","daily_rate","base_amount","notes"],[vid,c.customer_id,d.start,d.end,'reserved',rate,base,s(b.notes,1000)])));const bid=r.id,ref=`RF-${String(bid).padStart(5,'0')}`;(await repo.update('bookings',{id:bid},{ref:ref}));(await audit(null,'customer_reserve','booking',bid,ref));return json(res,201,{id:bid,ref,base_amount:base});});}
  if(method==='POST'&&resource==='bookings'&&ident&&action==='cancel')return transaction(async ()=>{const bid=id(ident);const b=(await repo.one('bookings',{id:bid,customer_id:c.customer_id}));if(!b)err('Booking not found',404);need(b.status==='reserved','Only reserved bookings can be cancelled',409);if((await repo.one('payments',{booking_id:bid})))err('Contact the rental team to cancel a booking with recorded payments',409);(await repo.update('bookings',{id:bid},{status:'cancelled',updated_at:repo.now()}));(await audit(null,'customer_cancel','booking',bid,b.ref));return json(res,200,{ok:true});});
  err('Customer endpoint not found',404);
}

async function route(req,res){
  const url=new URL(req.url,'http://localhost');const pathname=url.pathname;const method=req.method;
  if(pathname.startsWith('/api/')){
    // Origin was checked before database work.
    const parts=pathname.split('/').filter(Boolean);const resource=parts[1], ident=parts[2], action=parts[3];
    if(method==='GET'&&resource==='health')return json(res,200,{ok:true,store:'RentFleet',version:'2.0.0',database:'MongoDB connected',databaseName:repo.databaseName(),ownerConfigured:(await repo.count('users'))>0});
    if(resource==='customer')return customerRoute(req,res,url,parts);
    if(method==='GET'&&resource==='setup-status')return json(res,200,{needs_setup:(await repo.countAs('users',{},'n')).n===0});
    if(method==='POST'&&resource==='setup'){
      if(process.env.NODE_ENV==='production')err('Owner registration is disabled in production; configure OWNER_EMAIL and OWNER_PASSWORD on the server.',403);
      const b=await body(req);return transaction(async ()=>{if((await repo.countAs('users',{},'n')).n)err('Owner already exists',409);const name=required(b.name,'Name');const em=email(b.email);const pw=password(b.password);const result=(await repo.insert('users',repo.record(["full_name","email","pass_hash","role"],[name,em,passwordHash(pw),'owner'])));const u=(await repo.one('users',{id:result.id}));(await issueSession(req,res,u));(await audit(u,'setup','user',u.id));return json(res,201,{user:userSafe(u)});});
    }
    if(method==='POST'&&resource==='login'){
      const b=await body(req);const em=email(b.email);const u=(await repo.one('users',{email:em,active:1}));if(!u||typeof b.password!=='string'||b.password.length>128||!verifyPassword(b.password,u.pass_hash)){err('Invalid email or password',401);}(await issueSession(req,res,u));return json(res,200,{user:userSafe(u)});
    }
    if(method==='POST'&&resource==='logout'){(await clearSession(req,res));return json(res,200,{ok:true});}
    const u=(await auth(req));if(!u)err('Please sign in',401);
    if(method==='GET'&&resource==='me')return json(res,200,{user:userSafe(u),settings:(await getConfig())});
    if(method==='GET'&&resource==='dashboard')return json(res,200,(await dashboard()));
    if(method==='GET'&&resource==='vehicles')return json(res,200,{items:(await repo.vehicleRows())});
    if(resource==='vehicles'){
      if(method==='POST'&&!ident){requireManager(u);const b=await body(req);const v=vehicleForm(b);const r=await repo.insert('vehicles',{...v,...photoFields(b)});(await audit(u,'create','vehicle',r.id,v.registration));return json(res,201,{id:r.id});}
      if(ident){requireManager(u);const vid=id(ident),prev=(await repo.one('vehicles',{id:vid}));if(!prev)err('Vehicle not found',404);
        if(method==='PATCH'){const b=await body(req);const v={...vehicleForm(b,prev),...photoFields(b)};await updateFields('vehicles',vid,v,Object.keys(v));(await audit(u,'update','vehicle',vid));return json(res,200,{ok:true});}
        if(method==='DELETE'){(await repo.deleteVehicle(vid));(await audit(u,'delete','vehicle',vid,prev.registration));return json(res,200,{ok:true});}}
    }
    if(method==='GET'&&resource==='customers')return json(res,200,{items:(await repo.list('customers',{},{id:-1}))});
    if(resource==='customers'){
      if(method==='POST'&&!ident){const v=customerForm(await body(req));const r=(await repo.insert('customers',repo.record(["name","phone","email","license","address"],[...Object.values(v)])));(await audit(u,'create','customer',r.id));return json(res,201,{id:r.id});}
      if(ident){const cid=id(ident),prev=(await repo.one('customers',{id:cid}));if(!prev)err('Customer not found',404);
        if(method==='PATCH'){const v=customerForm(await body(req),prev);(await updateFields('customers',cid,v,Object.keys(v)));(await audit(u,'update','customer',cid));return json(res,200,{ok:true});}
        if(method==='DELETE'){requireManager(u);(await repo.deleteCustomer(cid));(await audit(u,'delete','customer',cid));return json(res,200,{ok:true});}}
    }
    if(method==='GET'&&resource==='bookings')return json(res,200,{items:(await bookingRows())});
    if(resource==='bookings'){
      if(method==='POST'&&!ident){const b=await body(req);return transaction(async ()=>{
        const vid=id(b.vehicle_id),cid=id(b.customer_id),start=date(b.start_date,'Start date'),end=date(b.end_date,'End date');const nights=daysBetween(start,end);need(nights>=1&&nights<=365,'Rental must be 1 to 365 days');const veh=(await repo.one('vehicles',{id:vid})),cust=(await repo.one('customers',{id:cid}));need(veh&&cust,'Select an existing vehicle and customer');need(veh.status==='available','Vehicle is out of service');need(!(await inService(vid)),'Vehicle is undergoing maintenance',409);const conflict=(await availability(vid,start,end));if(conflict)err(`Vehicle is already booked (${conflict.ref})`,409);
        const rate=veh.daily_rate,base=Math.round(rate*nights*100)/100;const notes=s(b.notes,1000);
        const r=(await repo.insert('bookings',repo.record(["vehicle_id","customer_id","start_date","end_date","status","daily_rate","base_amount","notes"],[vid,cid,start,end,'reserved',rate,base,notes])));const bid=r.id;const ref=`RF-${String(bid).padStart(5,'0')}`;(await repo.update('bookings',{id:bid},{ref:ref}));(await audit(u,'create','booking',bid,ref));return json(res,201,{id:bid,ref,base_amount:base});});}
      if(ident){const bid=id(ident),booking=(await repo.one('bookings',{id:bid}));if(!booking)err('Booking not found',404);
        if(method==='POST'&&action==='checkout'){const b=await body(req);return transaction(async ()=>{need(booking.status==='reserved','Only reserved bookings can be checked out');const veh=(await repo.one('vehicles',{id:booking.vehicle_id}));need(veh.status==='available'&&!(await inService(veh.id)),'Vehicle is out of service');const active=(await repo.one('bookings',{vehicle_id:veh.id,status:'active',id:{$ne:bid}}));if(active)err('Vehicle is already checked out',409);const odo=int(b.odometer,'Checkout odometer',veh.odometer);(await repo.update('bookings',{id:bid},{status:'active',checkout_odometer:odo,checkout_at:repo.now(),updated_at:repo.now()}));(await repo.update('vehicles',{id:veh.id},{odometer:odo}));(await audit(u,'checkout','booking',bid));return json(res,200,{ok:true});});}
        if(method==='POST'&&action==='return'){const b=await body(req);return transaction(async ()=>{need(booking.status==='active','Only active bookings can be returned');const veh=(await repo.one('vehicles',{id:booking.vehicle_id}));const odo=int(b.odometer,'Return odometer',Math.max(veh.odometer,booking.checkout_odometer||0));const extra=num(b.extra_charges??0,'Extra charges');(await repo.update('bookings',{id:bid},{status:'completed',return_odometer:odo,extra_charges:extra,returned_at:repo.now(),updated_at:repo.now()}));(await repo.update('vehicles',{id:veh.id},{odometer:odo}));(await audit(u,'return','booking',bid,`mileage:${odo},extra:${extra}`));return json(res,200,{ok:true});});}
        if(method==='POST'&&action==='cancel')return transaction(async ()=>{need(booking.status==='reserved','Only reserved bookings can be cancelled');if((await repo.one('payments',{booking_id:bid})))err('Remove or refund recorded payments before cancelling',409);(await repo.update('bookings',{id:bid},{status:'cancelled',updated_at:repo.now()}));(await audit(u,'cancel','booking',bid));return json(res,200,{ok:true});});
      }
    }
    if(method==='GET'&&resource==='maintenance')return json(res,200,{items:(await repo.maintenanceRows())});
    if(resource==='maintenance'){
      if(method==='POST'&&!ident){requireManager(u);const b=await body(req);const vid=id(b.vehicle_id);need((await repo.one('vehicles',{id:vid})),'Vehicle does not exist');const v={vehicle_id:vid,title:required(b.title,'Title'),status:s(b.status??'open'),cost:num(b.cost??0,'Cost'),due_date:date(b.due_date,'Due date'),notes:s(b.notes,1000)};need(['open','in_progress','done'].includes(v.status),'Invalid maintenance status');if(v.status==='in_progress'&&(await repo.one('bookings',{vehicle_id:vid,status:'active'})))err('Cannot start maintenance while vehicle is rented',409);const r=(await repo.insert('maintenance',repo.record(["vehicle_id","title","status","cost","due_date","notes"],[...Object.values(v)])));(await audit(u,'create','maintenance',r.id));return json(res,201,{id:r.id});}
      if(ident){requireManager(u);const mid=id(ident),prev=(await repo.one('maintenance',{id:mid}));if(!prev)err('Maintenance not found',404);
        if(method==='PATCH'){const b=await body(req);const v={title:required(b.title??prev.title,'Title'),status:s(b.status??prev.status),cost:num(b.cost??prev.cost,'Cost'),due_date:date(b.due_date??prev.due_date,'Due date'),notes:s(b.notes??prev.notes,1000)};need(['open','in_progress','done'].includes(v.status),'Invalid maintenance status');if(v.status==='in_progress'&&(await repo.one('bookings',{vehicle_id:prev.vehicle_id,status:'active'})))err('Vehicle is currently rented',409);(await updateFields('maintenance',mid,v,Object.keys(v)));(await repo.update('maintenance',{id:mid},{updated_at:repo.now()}));(await audit(u,'update','maintenance',mid));return json(res,200,{ok:true});}
        if(method==='DELETE'){(await repo.remove('maintenance',{id:mid}));(await audit(u,'delete','maintenance',mid));return json(res,200,{ok:true});}}
    }
    if(method==='GET'&&resource==='payments')return json(res,200,{items:(await repo.paymentRows())});
    if(resource==='payments'){
      if(method==='POST'&&!ident){const b=await body(req);const bid=id(b.booking_id),booking=(await bookingRow(bid));if(!booking)err('Booking not found',404);need(booking.status!=='cancelled','Cannot record payment on cancelled booking');const amount=num(b.amount,'Amount',0.01);need(amount<=Math.round((booking.base_amount+booking.extra_charges-booking.paid)*100)/100+0.001,'Payment exceeds outstanding balance');const method=s(b.method||'cash');need(['cash','bank','mobile','other'].includes(method),'Invalid payment method');const paidAt=date(b.paid_at??isoDay(),'Paid date');const ref=s(b.reference,160);const r=(await repo.insert('payments',repo.record(["booking_id","amount","method","reference","paid_at"],[bid,amount,method,ref,paidAt])));(await audit(u,'create','payment',r.id,String(amount)));return json(res,201,{id:r.id});}
      if(method==='DELETE'&&ident){requireManager(u);const pid=id(ident);const prev=(await repo.one('payments',{id:pid}));if(!prev)err('Payment not found',404);(await repo.remove('payments',{id:pid}));(await audit(u,'delete','payment',pid));return json(res,200,{ok:true});}
    }
    if(method==='GET'&&resource==='expenses')return json(res,200,{items:(await repo.expenseRows())});
    if(resource==='expenses'){
      if(method==='POST'&&!ident){const b=await body(req);const vid=b.vehicle_id?id(b.vehicle_id):null;if(vid&&!(await repo.one('vehicles',{id:vid})))err('Vehicle does not exist');const v={vehicle_id:vid,category:required(b.category,'Category',80),amount:num(b.amount,'Amount'),description:s(b.description,1000),spent_on:date(b.spent_on??isoDay(),'Spent on')};const r=(await repo.insert('expenses',repo.record(["vehicle_id","category","amount","description","spent_on"],[...Object.values(v)])));(await audit(u,'create','expense',r.id));return json(res,201,{id:r.id});}
      if(method==='DELETE'&&ident){requireManager(u);const eid=id(ident);need((await repo.one('expenses',{id:eid})),'Expense not found');(await repo.remove('expenses',{id:eid}));(await audit(u,'delete','expense',eid));return json(res,200,{ok:true});}
    }
    if(method==='GET'&&resource==='reports'){requireManager(u);const months=(await dashboard()).series;const top=(await repo.topVehicles());const counts=(await repo.statusCounts());const expenseTotal=(await repo.sumAs('expenses','amount')).total;const maintTotal=(await repo.sumAs('maintenance','cost')).total;const revenue=(await repo.sumAs('payments','amount')).total;return json(res,200,{months,top,counts,expense_total:expenseTotal+maintTotal,revenue_total:revenue,net_cash:revenue-expenseTotal-maintTotal});}
    if(method==='GET'&&resource==='users'){requireManager(u);return json(res,200,{items:(await repo.userRows())});}
    if(resource==='users'){
      if(method==='POST'&&!ident){requireOwner(u);const b=await body(req);const em=email(b.email);const name=required(b.name,'Name');const pw=password(b.password);const role=normalizeRole(b.role);const r=(await repo.insert('users',repo.record(["full_name","email","pass_hash","role"],[name,em,passwordHash(pw),role])));(await audit(u,'create','user',r.id));return json(res,201,{id:r.id});}
      if(method==='PATCH'&&ident){requireOwner(u);const uid=id(ident),prev=(await repo.one('users',{id:uid}));if(!prev)err('User not found',404);need(prev.role!=='owner','Cannot modify owner account here');const b=await body(req);const updates={full_name:required(b.name??prev.full_name,'Name'),role:normalizeRole(b.role??prev.role),active:b.active===undefined?prev.active:(b.active?1:0)};if(b.password)updates.pass_hash=passwordHash(password(b.password));(await updateFields('users',uid,updates,Object.keys(updates)));if(!updates.active)(await repo.remove('sessions',{user_id:uid}));(await audit(u,'update','user',uid));return json(res,200,{ok:true});}
    }
    if(method==='GET'&&resource==='settings')return json(res,200,(await getConfig()));
    if(method==='PUT'&&resource==='settings'){requireOwner(u);const b=await body(req);const config={company:required(b.company,'Company',120),currency:required(b.currency,'Currency',8).toUpperCase(),phone:s(b.phone,40),address:s(b.address,300)};for(const [key,val] of Object.entries(config))(await setConfig(key,val));(await audit(u,'update','settings',null));return json(res,200,config);}
    if(method==='GET'&&resource==='audit'){requireOwner(u);return json(res,200,{items:(await repo.auditRows())});}
    if(method==='GET'&&resource==='export'){requireManager(u);const target=s(url.searchParams.get('type'));const types=['vehicles','customers','bookings','payments','expenses','maintenance'];need(types.includes(target),'Invalid export type');const rows=target==='bookings'?await bookingRows():await repo.list(target);const fields=target==='vehicles'?['id','registration','make','model','year','category','daily_rate','odometer','status','notes']:target==='customers'?['id','name','phone','email','license','address']:target==='bookings'?['ref','registration','customer_name','start_date','end_date','status','base_amount','extra_charges','paid']:target==='payments'?['id','booking_id','amount','method','reference','paid_at']:target==='expenses'?['id','vehicle_id','category','amount','description','spent_on']:['id','vehicle_id','title','status','cost','due_date','notes'];const cell=x=>{let val=String(x??'');if(/^[=+@\-\t\r]/.test(val))val="'"+val;return '"'+val.replace(/"/g,'""')+'"';};const csv='\ufeff'+fields.map(cell).join(',')+'\r\n'+rows.map(r=>fields.map(f=>cell(r[f])).join(',')).join('\r\n');res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="rentfleet-${target}-${isoDay()}.csv"`,'X-Content-Type-Options':'nosniff'});return res.end(csv);}
    err('API endpoint not found',404);
  }

  err('Not found',404);
}
module.exports={route,sendError,passwordHash,password,email,required};
