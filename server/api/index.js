'use strict';
const handler=require('../server');
module.exports=(req,res)=>{const u=new URL(req.url,'http://localhost');const rewritten=u.searchParams.get('__rf_path');if(rewritten!==null){if(!/^[a-zA-Z0-9_\/-]+$/.test(rewritten)){res.statusCode=400;return res.end('Invalid API path');}u.pathname='/api/'+rewritten.replace(/^\/+/, '');u.searchParams.delete('__rf_path');req.url=u.pathname+u.search;}return handler(req,res);};
