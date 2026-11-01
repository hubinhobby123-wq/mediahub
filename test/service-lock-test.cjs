const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { acquire } = require('../server/serviceLock');
test('one database has one owner; releasing it permits a new scheduler',()=>{
  const dir=path.resolve('.tmp-lock-tests-'+crypto.randomUUID());
  try {const release=acquire(dir);assert.throws(()=>acquire(dir),/已有MediaHub/);release();const second=acquire(dir);second();assert.equal(fs.existsSync(path.join(dir,'.mediahub-service.lock')),false);}
  finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('corrupt locks do not start another scheduler',()=>{
  const dir=path.resolve('.tmp-lock-tests-'+crypto.randomUUID());fs.mkdirSync(dir,{recursive:true});
  try{fs.writeFileSync(path.join(dir,'.mediahub-service.lock'),'bad');assert.throws(()=>acquire(dir),/锁异常/);assert.equal(fs.readFileSync(path.join(dir,'.mediahub-service.lock'),'utf8'),'bad');}
  finally {fs.rmSync(dir,{recursive:true,force:true});}
});
