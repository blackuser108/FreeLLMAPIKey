import pg from 'pg';

// A small parameterized tag over node-postgres, not a SQL dialect translator.
// All interpolated values become $n parameters; identifiers are static source.
// https://node-postgres.com/features/queries
function tagFor(query) {
  const tag=(parts,...values)=>{
    if(!Array.isArray(parts)||!Object.hasOwn(parts,'raw'))throw new TypeError('SQL must be a template literal');
    let text=parts[0];for(let i=0;i<values.length;i++)text+=`$${i+1}`+parts[i+1];
    return query({text,values});
  };
  tag.json=value=>value;
  return tag;
}
export function createDatabase(url,ssl) {
  const pool=new pg.Pool({connectionString:url,ssl,max:1,pipeline:false,
    connectionTimeoutMillis:8000,idleTimeoutMillis:5000,maxLifetimeSeconds:60,
    query_timeout:8000,statement_timeout:8000,application_name:'freellmapi-cloud'});
  pool.on('error',()=>{}); // A dropped idle connection is discarded by pg-pool.
  const leased=new Set();
  async function withClient(fn){
    const client=await pool.connect();leased.add(client);
    try{return await fn(client);}finally{if(leased.delete(client))client.release();}
  }
  const db=tagFor(config=>withClient(async client=>(await client.query(config)).rows));
  // Transactions always use one leased client, as required by node-postgres.
  // https://node-postgres.com/features/transactions
  db.begin=fn=>withClient(async client=>{
    await client.query('BEGIN');
    try{
      const value=await fn(tagFor(async config=>(await client.query(config)).rows));
      await client.query('COMMIT');return value;
    }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
  });
  db.end=async(options={})=>{
    if(options.timeout===0)for(const client of leased){leased.delete(client);client.release(true);}
    await pool.end();
  };
  return db;
}
