'use strict';
require('./env.cjs');const db=require('./repository');
(async()=>{try{await db.connect();await db.atomic(async()=>{});console.log('MongoDB connected successfully: '+db.databaseName());console.log('MongoDB write transaction test passed.');}catch(e){console.error('MongoDB connection failed:',e.message);process.exitCode=1;}finally{await db.close();}})();
