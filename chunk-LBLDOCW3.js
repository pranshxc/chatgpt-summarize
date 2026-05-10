import{a as w,k as v,l as x,n as P,o as N}from"./chunk-XZOEFNRP.js";import{d as c,e as E,h}from"./chunk-W7D2TEGV.js";

async function safeJson(response){
  const ct=response.headers.get("content-type")||"";
  const text=await response.text();
  if(!text||!text.trim())return null;
  if(!ct.includes("application/json")){
    console.warn("[safeJson] Non-JSON response (content-type:",ct,") body:",text.slice(0,300));
    return{__rawHtml__:text.slice(0,300),__contentType__:ct}
  }
  try{return JSON.parse(text)}
  catch(e){console.error("[safeJson] JSON parse failed:",text.slice(0,300));throw new Error("Server returned invalid response")}
}

// Ask background SW to read DeepSeek cookies from the user's browser session.
// The user must already be logged in at https://chat.deepseek.com.
// No email/password is ever sent or stored.
function deepseekConnectViaBackground(){
  return new Promise(resolve=>{
    try{
      chrome.runtime.sendMessage({type:"DEEPSEEK_LOGIN"},response=>{
        if(chrome.runtime.lastError){
          console.warn("[DeepSeek] sendMessage error:",chrome.runtime.lastError.message);
          resolve({error:"Background connect failed: "+chrome.runtime.lastError.message});
          return;
        }
        resolve(response||{error:"No response from background worker"});
      });
    }catch(e){
      console.warn("[DeepSeek] deepseekConnectViaBackground failed:",e);
      resolve({error:e?.message||"Unable to connect to DeepSeek"});
    }
  });
}

async function C(e,t){
  if(!t)throw new Error("No token provided");
  let r=await fetch(e,{headers:{Authorization:`Bearer ${t}`}}),n=await safeJson(r);
  if(!r.ok)throw new Error(n?.detail?.message||"Unknown Error");
  return n
}

function p(e,t,r){
  return v(t&&e?t:null,async o=>{
    if(o==="local")return r([]);
    let d=await C(o,e||"");
    return r(d)
  },{shouldRetryOnError:!0})
}

function R(e,t){let r=N.getConfig(t);return p(e,e?r.modelsUrl:null,r.mapModelsResponse)}

var a=c(E()),m=c(w());var f=c(w());

// Connect: reads existing browser session cookies — no credentials needed
async function A(){
  try{
    const result=await deepseekConnectViaBackground();
    if(result&&"cookieStr" in result){
      return{cookieStr:result.cookieStr}
    }
    return{error:result?.error||"DeepSeek connect failed. Please make sure you are logged in at https://chat.deepseek.com"}
  }catch(r){
    return console.error("Connect error",r),{error:r?.message||"An error occurred during connect"}
  }
}

var s=c(h());

function D({onLoginStatusChange:e,callback:t}){let[u,y]=(0,a.useState)(!1),[k,b]=(0,a.useState)(null),[l,g]=(0,a.useState)(!1);

  // On mount, check if we already have a stored cookie session
  (0,a.useEffect)(()=>{
    (async()=>{
      let i=await m.default.storage.local.get({"deepseek-cookie":""});
      if(i["deepseek-cookie"]){
        g(!0);
        e&&e(!0);
      }else{
        e&&e(!1);
      }
    })();
  },[e]);

  return(0,s.jsxs)("div",{className:"flex flex-col gap-3 text-sm",children:[
    !l&&(0,s.jsx)("p",{className:"text-xs text-gray-500 dark:text-gray-400 leading-snug",children:"To use DeepSeek, first log in at chat.deepseek.com in your browser, then click Connect below."}),
    k&&(0,s.jsx)("div",{className:"text-red-500 text-xs leading-snug whitespace-pre-line",children:k}),
    (0,s.jsxs)("div",{className:"flex items-center justify-end gap-2",children:[
      !l&&(0,s.jsx)("button",{type:"button",onClick:async()=>{
        if(u)return;
        y(!0);b(null);
        let i=await A();
        if("cookieStr" in i){
          await m.default.storage.local.set({"deepseek-cookie":i.cookieStr});
          g(!0);
          e&&e(!0);
          t&&t();
        }else{
          b(i.error);
        }
        y(!1);
      },disabled:u,className:`items-center rounded-md border border-transparent bg-primary-500
              px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-primary-700
              focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2
              disabled:cursor-not-allowed disabled:bg-primary-300 disabled:opacity-50`,
        children:u?(0,s.jsx)(x,{style:"flex h-5 w-5 items-center justify-center"}):"Connect DeepSeek"}),
      l&&(0,s.jsx)("button",{type:"button",onClick:async()=>{
        await m.default.storage.local.remove(["deepseek-cookie","deepseek-token","deepseek-login","deepseek-password"]);
        g(!1);e&&e(!1);
      },className:`items-center rounded-md border border-transparent bg-red-500
              px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-red-700
              focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2`,
        children:"Disconnect"})
    ]})
  ]});
}

var J=D;export{R as a,J as b};
