'use strict';
const {AsyncLocalStorage}=require('node:async_hooks');
const context=new AsyncLocalStorage();
const names=['users','sessions','customer_accounts','customer_sessions','settings','vehicles','customers','bookings','maintenance','payments','expenses','audit','counters','locks','rate_limits'];
const idTables=names.filter(n=>!['sessions','customer_sessions','settings','counters','locks','rate_limits'].includes(n));
let client,db,connecting;
function databaseName(){return process.env.MONGODB_DB||'RentFleet';}
function col(name){if(!names.includes(name))throw Error('Unknown collection');if(!db)throw Error('Database unavailable');return db.collection(name);}
function opts(){const session=context.getStore();return session?{session}:{};}
function now(){return new Date().toISOString().replace('T',' ').slice(0,19);}
function record(keys,values){return Object.fromEntries(keys.map((k,i)=>[k,values[i]]));}
async function connect(){if(db&& !connecting)return db;if(connecting)return connecting;connecting=(async()=>{
 const uri=process.env.MONGODB_URI;if(!uri||!/^mongodb(?:\+srv)?:\/\//.test(uri)||/YOUR_PASSWORD|<db_password>/.test(uri))throw Error('Set a valid MONGODB_URI in server environment');
 const {MongoClient}=require('mongodb');client=new MongoClient(uri,{serverSelectionTimeoutMS:10000,maxPoolSize:10});await client.connect();db=client.db(databaseName());await db.command({ping:1});
 for(const n of idTables)await col(n).createIndex({id:1},{unique:true});
 for(const [n,k] of [['users','email'],['customer_accounts','email'],['customer_accounts','customer_id'],['vehicles','registration'],['sessions','token_hash'],['customer_sessions','token_hash'],['settings','key']])await col(n).createIndex({[k]:1},{unique:true});
 for(const n of ['sessions','customer_sessions']){await col(n).createIndex({expiry_date:1},{expireAfterSeconds:0});}
 await col('bookings').createIndex({ref:1},{unique:true,partialFilterExpression:{ref:{$type:'string'}}});
 await col('bookings').createIndex({vehicle_id:1,status:1,start_date:1,end_date:1});await col('bookings').createIndex({customer_id:1});await col('payments').createIndex({booking_id:1});await col('maintenance').createIndex({vehicle_id:1,status:1});await col('expenses').createIndex({vehicle_id:1});
 await col('rate_limits').createIndex({expires_at:1},{expireAfterSeconds:0});
 await col('counters').createIndex({seq:1});
 await col('locks').updateOne({_id:'writes'},{$setOnInsert:{revision:0}},{upsert:true});return db;
 })();try{return await connecting;}catch(e){if(client)await client.close().catch(()=>{});client=undefined;db=undefined;throw e;}finally{connecting=undefined;}}
async function close(){if(client)await client.close();client=undefined;db=undefined;connecting=undefined;}
// All write requests serialize via one durable transaction lock. This avoids double bookings across Vercel instances.
async function atomic(work){await connect();const session=client.startSession();try{return await session.withTransaction(async()=>context.run(session,async()=>{await col('locks').updateOne({_id:'writes'},{$inc:{revision:1}},opts());return work();}),{readConcern:{level:'snapshot'},writeConcern:{w:'majority'},maxCommitTimeMS:10000});}finally{await session.endSession();}}
function projection(n){return n==='vehicles'?{_id:0,photo_data:0}:{_id:0};}
async function one(n,f={}){return col(n).findOne(f,{...opts(),projection:projection(n)});}
async function vehiclePhoto(id){return col('vehicles').findOne({id},{...opts(),projection:{_id:0,photo_data:1}});}
async function list(n,f={},sort={},limit=0){let q=col(n).find(f,{...opts(),projection:projection(n)});if(Object.keys(sort).length)q=q.sort(sort);if(limit)q=q.limit(limit);return q.toArray();}
async function count(n,f={}){return col(n).countDocuments(f,opts());}
async function countAs(n,f,key){return {[key]:await count(n,f)};}
async function sumAs(n,k){const a=await col(n).aggregate([{$group:{_id:null,total:{$sum:'$'+k}}}],opts()).toArray();return {total:a[0]?.total||0};}
const defaults={users:{active:1},vehicles:{odometer:0,status:'available',notes:''},customers:{email:'',license:'',address:''},bookings:{ref:null,status:'reserved',extra_charges:0,checkout_odometer:null,return_odometer:null,checkout_at:null,returned_at:null,notes:''},maintenance:{status:'open',cost:0,notes:''},payments:{reference:''},expenses:{vehicle_id:null,description:''},audit:{user_id:null,target_id:null,details:''}};
async function insert(n,fields){if(!context.getStore())throw Error('Write outside transaction');const doc={...(defaults[n]||{}),...fields};if(idTables.includes(n)){const seq=await col('counters').findOneAndUpdate({_id:n},{$inc:{seq:1}},{...opts(),upsert:true,returnDocument:'after'});doc.id=seq.seq;doc.created_at=now();if(['bookings','maintenance'].includes(n))doc.updated_at=doc.created_at;}if(n==='sessions'||n==='customer_sessions')doc.expiry_date=new Date(doc.expires_at);await col(n).insertOne(doc,opts());return {...doc};}
async function update(n,f,fields){return col(n).updateOne(f,{$set:fields},opts());}
async function remove(n,f){return col(n).deleteMany(f,opts());}
async function upsertSetting(key,value){return col('settings').updateOne({key},{$set:{value}},{...opts(),upsert:true});}
async function throttle(key,limit=12){const window=15*60*1000;const bucket=Math.floor(Date.now()/window);const id=require('node:crypto').createHash('sha256').update(key+':'+bucket).digest('hex');const item=await col('rate_limits').findOneAndUpdate({_id:id},{$inc:{count:1},$setOnInsert:{expires_at:new Date((bucket+2)*window)}},{upsert:true,returnDocument:'after'});if(item.count>limit){const e=Error('Too many attempts. Try again later.');e.status=429;throw e;}}
function conflict(message){const e=Error(message);e.status=409;throw e;}
async function deleteVehicle(id){if(await one('bookings',{vehicle_id:id})||await one('maintenance',{vehicle_id:id}))conflict('Vehicle has related bookings or maintenance');await col('expenses').updateMany({vehicle_id:id},{$set:{vehicle_id:null}},opts());return remove('vehicles',{id});}
async function deleteCustomer(id){if(await one('bookings',{customer_id:id})||await one('customer_accounts',{customer_id:id}))conflict('Customer has related bookings or an account');return remove('customers',{id});}
async function adminSession(token_hash,now){const s=await one('sessions',{token_hash,expires_at:{$gt:now}});return s?one('users',{id:s.user_id,active:1}):null;}
async function customerDetails(a){if(!a)return null;const c=await one('customers',{id:a.customer_id});return c?{...a,name:c.name,phone:c.phone,address:c.address}:null;}
async function customerByEmail(email){return customerDetails(await one('customer_accounts',{email}));}
async function customerAuth(token_hash,now){const s=await one('customer_sessions',{token_hash,expires_at:{$gt:now}});return s?customerDetails(await one('customer_accounts',{id:s.account_id})):null;}
async function joinedBookings(f={}){const bookings=await list('bookings',f,{id:-1});const ids=bookings.map(b=>b.id),vs=[...new Set(bookings.map(b=>b.vehicle_id))],cs=[...new Set(bookings.map(b=>b.customer_id))];const vehicles=new Map((await list('vehicles',{id:{$in:vs}})).map(v=>[v.id,v]));const customers=new Map((await list('customers',{id:{$in:cs}})).map(c=>[c.id,c]));const paid=new Map();for(const p of await list('payments',{booking_id:{$in:ids}}))paid.set(p.booking_id,(paid.get(p.booking_id)||0)+p.amount);return bookings.map(b=>{const v=vehicles.get(b.vehicle_id)||{},c=customers.get(b.customer_id)||{};return {...b,registration:v.registration,make:v.make,model:v.model,category:v.category,vehicle_odometer:v.odometer,customer_name:c.name,customer_phone:c.phone,paid:paid.get(b.id)||0};});}
async function bookingRows(){return joinedBookings();}
async function bookingRow(id){return (await joinedBookings({id}))[0]||null;}
async function customerBookings(customer_id){const keys=['id','ref','start_date','end_date','status','daily_rate','base_amount','extra_charges','created_at','make','model','category','paid'];return (await joinedBookings({customer_id})).map(b=>Object.fromEntries(keys.map(k=>[k,b[k]])));}
async function vehicleRows(){const vehicles=await list('vehicles',{}, {id:-1});const active=await list('bookings',{status:'active'});const service=await list('maintenance',{status:'in_progress'});return vehicles.map(v=>({...v,on_rent:active.filter(b=>b.vehicle_id===v.id).length,in_maintenance:service.filter(m=>m.vehicle_id===v.id).length}));}
async function maintenanceRows(){const v=new Map((await list('vehicles')).map(x=>[x.id,x]));return (await list('maintenance',{}, {id:-1})).map(m=>({...m,registration:v.get(m.vehicle_id)?.registration,make:v.get(m.vehicle_id)?.make,model:v.get(m.vehicle_id)?.model}));}
async function paymentRows(){const b=new Map((await list('bookings')).map(x=>[x.id,x]));const c=new Map((await list('customers')).map(x=>[x.id,x]));return (await list('payments',{}, {id:-1})).map(p=>({...p,ref:b.get(p.booking_id)?.ref,customer_name:c.get(b.get(p.booking_id)?.customer_id)?.name}));}
async function expenseRows(){const v=new Map((await list('vehicles')).map(x=>[x.id,x]));return (await list('expenses',{}, {id:-1})).map(e=>({...e,registration:v.get(e.vehicle_id)?.registration??null}));}
async function topVehicles(){const vehicles=await list('vehicles');const bookings=await list('bookings');return vehicles.map(v=>{const bs=bookings.filter(b=>b.vehicle_id===v.id);return {registration:v.registration,make:v.make,model:v.model,bookings:bs.length,booked_value:bs.filter(b=>b.status!=='cancelled').reduce((a,b)=>a+b.base_amount+b.extra_charges,0)};}).sort((a,b)=>b.bookings-a.bookings).slice(0,8);}
async function statusCounts(){const m=new Map();for(const b of await list('bookings'))m.set(b.status,(m.get(b.status)||0)+1);return [...m].map(([status,count])=>({status,count}));}
async function userRows(){return (await list('users',{}, {id:1})).map(({id,full_name,email,role,active,created_at})=>({id,name:full_name,email,role,active,created_at}));}
async function auditRows(){const u=new Map((await list('users')).map(x=>[x.id,x.full_name]));return (await list('audit',{}, {id:-1},100)).map(a=>({...a,actor:u.get(a.user_id)??null}));}
module.exports={vehiclePhoto,databaseName,connect,close,atomic,throttle,now,record,one,list,count,countAs,sumAs,insert,update,remove,upsertSetting,deleteVehicle,deleteCustomer,adminSession,customerByEmail,customerAuth,bookingRows,bookingRow,customerBookings,vehicleRows,maintenanceRows,paymentRows,expenseRows,topVehicles,statusCounts,userRows,auditRows};
