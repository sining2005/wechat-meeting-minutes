const cloud=require("wx-server-sdk");
cloud.init({env:cloud.DYNAMIC_CURRENT_ENV});
const db=cloud.database();
const collections=["meetings","audioSegments","processingJobs","providerConfigs","invitedUsers"];

exports.main=async()=>{
  const results=[];
  for(const name of collections){
    try{await db.createCollection(name);results.push({name,created:true});}
    catch(e){const exists=/exist|already/i.test(e.message||"");if(!exists)throw e;results.push({name,created:false,reason:"already exists"});}
  }
  return {ok:true,environment:cloud.DYNAMIC_CURRENT_ENV,collections:results,next:"Apply database.rules.json, then deploy api and processor."};
};
