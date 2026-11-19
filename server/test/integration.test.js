'use strict';
if(!process.env.MONGODB_TEST_URI){require('node:test').test('Atlas tests require MONGODB_TEST_URI',{skip:true},()=>{});return;}

const {test} = require('node:test');
const {randomUUID}=require('node:crypto');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {mkdtempSync,rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const path = require('node:path');

const PORT=48300+Math.floor(Math.random()*400);
const dbName='RentFleet_test_'+randomUUID().replaceAll('-','');
const ROOT=path.join(__dirname,'..');
const temp=mkdtempSync(path.join(tmpdir(),'rentfleet-test-'));
const URL=`http://127.0.0.1:${PORT}`;
let server;
async function start(){server=spawn(process.execPath,['server.js'],{cwd:ROOT,env:{...process.env,PORT:String(PORT),MONGODB_URI:process.env.MONGODB_TEST_URI,MONGODB_DB:dbName,NODE_ENV:'test',OWNER_EMAIL:'',OWNER_PASSWORD:'',HOST:'127.0.0.1'},stdio:'pipe'});let output='';server.stderr.on('data',d=>output+=d.toString());for(let i=0;i<700;i++){if(server.exitCode!==null)throw Error(`Server died: ${output}`);try{const r=await fetch(URL+'/api/health');if(r.ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,75));}throw Error('Server did not start: '+output);}
async function stop(){if(!server)return;const proc=server;server=null;proc.kill('SIGTERM');await new Promise(resolve=>{if(proc.exitCode!==null){resolve();return;}proc.once('exit',resolve);setTimeout(resolve,1600);});}
async function request(uri,method='GET',data=undefined,cookie=''){const headers={};if(data!==undefined)headers['Content-Type']='application/json';if(cookie)headers.Cookie=cookie;const r=await fetch(URL+uri,{method,headers,body:data===undefined?undefined:JSON.stringify(data)});const type=r.headers.get('content-type')||'';const response=type.includes('json')?await r.json():await r.text();return{status:r.status,data:response,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
function check(status,resp){assert.equal(resp.status,status,JSON.stringify(resp.data));return resp.data;}
test('RentFleet core workflows, authorization, persistence and exports',async t=>{
 await start();
 try{
  let owner='';let staff='';let vehicleId,customerId,bookingId;
  await t.test('first run is empty; setup creates secure owner session',async()=>{
   assert.equal(check(200,await request('/api/setup-status')).needs_setup,true);
   check(401,await request('/api/dashboard'));
   check(400,await request('/api/setup','POST',{name:'Test',email:'x@y.z',password:'short'}));
   const created=await request('/api/setup','POST',{name:'Fleet Owner',email:'owner@example.com',password:'securePass123!'});check(201,created);owner=created.cookie;assert.ok(owner?.startsWith('rf_session='));
   assert.equal(check(200,await request('/api/me','GET',undefined,owner)).user.role,'owner');
   check(409,await request('/api/setup','POST',{name:'Duplicate',email:'owner2@example.com',password:'securePass123!'}));
   check(401,await request('/api/login','POST',{email:'owner@example.com',password:'wrongpass'}));
   check(200,await request('/api/login','POST',{email:'owner@example.com',password:'securePass123!'}));
  });
  await t.test('vehicles, customer and duplicate registration conflict',async()=>{
   let res=await request('/api/vehicles','POST',{registration:'DHAKA-001',make:'Toyota',model:'Corolla',year:2021,category:'Sedan',daily_rate:3500,odometer:40000,status:'available'},owner);vehicleId=check(201,res).id;
   check(409,await request('/api/vehicles','POST',{registration:'DHAKA-001',make:'Honda',model:'Civic',year:2020,category:'Sedan',daily_rate:3500,odometer:100},owner));
   check(400,await request(`/api/vehicles/${vehicleId}`,'PATCH',{odometer:5},owner));
   check(200,await request(`/api/vehicles/${vehicleId}`,'PATCH',{daily_rate:4200},owner));
   res=await request('/api/customers','POST',{name:'Samira Chowdhury',phone:'01700000000',email:'samira@example.com',license:'BD-1234'},owner);customerId=check(201,res).id;
   assert.equal(check(200,await request('/api/dashboard','GET',undefined,owner)).available,1);
  });
  await t.test('reservations validate dates and reject overlaps',async()=>{
   const body={vehicle_id:vehicleId,customer_id:customerId,start_date:'2027-01-10',end_date:'2027-01-13'};
   check(400,await request('/api/bookings','POST',{...body,end_date:'2027-01-10'},owner));
   const book=check(201,await request('/api/bookings','POST',body,owner));bookingId=book.id;assert.equal(book.base_amount,12600);
   check(409,await request('/api/bookings','POST',{...body,start_date:'2027-01-12',end_date:'2027-01-16'},owner));
   check(201,await request('/api/bookings','POST',{...body,start_date:'2027-01-13',end_date:'2027-01-14'},owner));
   check(409,await request(`/api/vehicles/${vehicleId}`,'DELETE',undefined,owner));
  });
  await t.test('checkout, mileage, return and payments',async()=>{
   check(400,await request(`/api/bookings/${bookingId}/checkout`,'POST',{odometer:120},owner));
   check(200,await request(`/api/bookings/${bookingId}/checkout`,'POST',{odometer:40100},owner));
   check(400,await request(`/api/bookings/${bookingId}/checkout`,'POST',{odometer:40100},owner));
   check(409,await request('/api/maintenance','POST',{vehicle_id:vehicleId,title:'Oil change',status:'in_progress',cost:500,due_date:'2027-01-11'},owner));
   check(400,await request(`/api/bookings/${bookingId}/return`,'POST',{odometer:40099},owner));
   check(200,await request(`/api/bookings/${bookingId}/return`,'POST',{odometer:40420,extra_charges:400},owner));
   check(400,await request(`/api/bookings/${bookingId}/return`,'POST',{odometer:40421},owner));
   check(400,await request('/api/payments','POST',{booking_id:bookingId,amount:16000,method:'cash',paid_at:'2027-01-12'},owner));
   check(201,await request('/api/payments','POST',{booking_id:bookingId,amount:5000,method:'mobile',paid_at:'2027-01-12',reference:'TX101'},owner));
   check(200,await request('/api/bookings','GET',undefined,owner));
   const b=check(200,await request('/api/bookings','GET',undefined,owner)).items.find(x=>x.id===bookingId);assert.equal(b.paid,5000);assert.equal(b.status,'completed');assert.equal(b.return_odometer,40420);
  });
  await t.test('maintenance, expenses, billing and exports',async()=>{
   const m=check(201,await request('/api/maintenance','POST',{vehicle_id:vehicleId,title:'Brake inspection',status:'in_progress',cost:800,due_date:'2027-01-20'},owner));
   check(409,await request('/api/bookings','POST',{vehicle_id:vehicleId,customer_id:customerId,start_date:'2027-01-20',end_date:'2027-01-21'},owner));
   check(200,await request(`/api/maintenance/${m.id}`,'PATCH',{status:'done'},owner));
   check(201,await request('/api/expenses','POST',{vehicle_id:vehicleId,category:'Fuel',amount:500,description:'Refuel',spent_on:'2027-01-20'},owner));
   const report=check(200,await request('/api/reports','GET',undefined,owner));assert.equal(report.revenue_total,5000);assert.equal(report.expense_total,1300);
   const csv=await request('/api/export?type=bookings','GET',undefined,owner);assert.equal(csv.status,200);assert.ok(csv.data.includes('RF-00001'));
  });
  await t.test('owner creates staff and server blocks manager-only actions',async()=>{
   const u=check(201,await request('/api/users','POST',{name:'Assistant Staff',email:'staff@example.com',password:'staff123456',role:'staff'},owner));
   const login=await request('/api/login','POST',{email:'staff@example.com',password:'staff123456'});check(200,login);staff=login.cookie;
   check(403,await request('/api/vehicles','POST',{registration:'NOPE',make:'X',model:'Y',year:2022,category:'SUV',daily_rate:100},staff));
   check(403,await request('/api/users','POST',{name:'Nope',email:'bad@example.com',password:'securePass123!',role:'admin'},staff));
   check(403,await request('/api/reports','GET',undefined,staff));
   check(403,await request('/api/export?type=payments','GET',undefined,staff));
   check(201,await request('/api/customers','POST',{name:'Staff Customer',phone:'123'},staff));
   check(200,await request(`/api/users/${u.id}`,'PATCH',{active:false},owner));
   check(401,await request('/api/me','GET',undefined,staff));
  });
  await t.test('restart preserves MongoDB state and owner authentication',async()=>{
   await stop();await start();
   const login=await request('/api/login','POST',{email:'owner@example.com',password:'securePass123!'});check(200,login);owner=login.cookie;
   const vehicles=check(200,await request('/api/vehicles','GET',undefined,owner));assert.equal(vehicles.items.length,1);
   const bookings=check(200,await request('/api/bookings','GET',undefined,owner));assert.equal(bookings.items.length,2);
   const newSetup=check(200,await request('/api/setup-status'));assert.equal(newSetup.needs_setup,false);
   check(200,await request('/api/logout','POST',{},owner));check(401,await request('/api/me','GET',undefined,owner));
  });
 }finally{await stop();await cleanup();rmSync(temp,{recursive:true,force:true});}
});

async function cleanup(){if(!/^RentFleet_test_[a-f0-9]{32}$/.test(dbName))throw Error('Unsafe test database name');const {MongoClient}=require('mongodb');const c=new MongoClient(process.env.MONGODB_TEST_URI);try{await c.connect();await c.db(dbName).dropDatabase();}finally{await c.close();}}
