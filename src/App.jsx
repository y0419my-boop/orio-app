import { useState, useEffect, useRef, useCallback } from "react";

const COLORS = {
  bg: "#070D1A", bgCard: "#0D1827", bgDeep: "#050B15",
  navy: "#1A2D4A", gold: "#C9A84C", goldLight: "#E8C96A",
  goldDim: "#8B6914", text: "#E8EEF8", textMuted: "#607090",
  textDim: "#3A4A60", green: "#1D9E75", border: "#1A2D4A", red: "#E24B4A",
};

const INIT_EPISODES = [
  { id:1, title:"30代から始める資産形成 最初の一歩は何をすべきか", creator:"山田 マネー", category:"お金・投資", duration:"22分", plays:"4.2k", hasAI:true, isOwn:false, audioUrl:null, summary:["まず緊急資金3ヶ月分を確保する","新NISAの積立枠から開始が最適","インデックス投資が初心者の正解","月3万円から無理なく継続する","複利効果を最大限に活用する"] },
  { id:2, title:"新NISA完全攻略ガイド2025年版", creator:"投資Lab · 田中ケン", category:"お金・投資", duration:"18分", plays:"6.8k", hasAI:true, isOwn:false, audioUrl:null, summary:["成長投資枠と積立投資枠の違い","年間360万円の非課税枠を活用","おすすめ銘柄ランキングTOP5","始める前に知るべき3つのこと","出口戦略まで考えて投資する"] },
  { id:3, title:"スキンケア初心者が最初にやること", creator:"メンズビューティLab · 佐藤", category:"メンズ美容", duration:"12分", plays:"3.1k", hasAI:false, isOwn:false, audioUrl:null, summary:[] },
  { id:4, title:"副業で月10万を達成した具体的な方法", creator:"副業チャンネル · 木村リョウ", category:"キャリア", duration:"25分", plays:"9.3k", hasAI:true, isOwn:false, audioUrl:null, summary:["副業選びの3つの基準を理解する","SNS発信が最速の収益化ルート","最初の1万円を稼ぐまでの戦略","本業との両立タイムマネジメント","月10万達成後のスケールアップ法"] },
];

const CATEGORIES = ["すべて","お金・投資","メンズ美容","キャリア"];

function fmtSec(s){ return `${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`; }

function ORIOLogo({size=1}){
  const d=22*size;
  return <svg width={d} height={d} viewBox="0 0 22 22" fill="none">
    <circle cx="11" cy="11" r="7" stroke={COLORS.gold} strokeWidth="1.5"/>
    <circle cx="11" cy="11" r="3.5" stroke={COLORS.gold} strokeWidth="1.5"/>
    <circle cx="11" cy="11" r="1" fill={COLORS.gold}/>
    <line x1="11" y1="4" x2="11" y2="2" stroke={COLORS.gold} strokeWidth="1.5" strokeLinecap="round"/>
    <line x1="11" y1="20" x2="11" y2="18" stroke={COLORS.gold} strokeWidth="1.5" strokeLinecap="round"/>
    <line x1="4" y1="11" x2="2" y2="11" stroke={COLORS.gold} strokeWidth="1.5" strokeLinecap="round"/>
    <line x1="20" y1="11" x2="18" y2="11" stroke={COLORS.gold} strokeWidth="1.5" strokeLinecap="round"/>
  </svg>;
}

function Waveform({active,bars=14}){
  const heights=[7,14,9,20,11,18,8,22,10,16,6,13,19,8];
  const [tick,setTick]=useState(0);
  useEffect(()=>{ if(!active)return; const id=setInterval(()=>setTick(t=>t+1),110); return()=>clearInterval(id); },[active]);
  return <div style={{display:"flex",alignItems:"center",gap:2,height:28}}>
    {Array.from({length:bars}).map((_,i)=>{
      const h=active&&i===tick%heights.length?heights[i%heights.length]*1.4:heights[i%heights.length];
      return <div key={i} style={{width:3,height:h,borderRadius:2,background:i%2===0?COLORS.gold:COLORS.navy,opacity:i%2===0?0.9:1,flexShrink:0}}/>;
    })}
  </div>;
}

function Badge({children,color=COLORS.textMuted,bg=COLORS.bgDeep,border=COLORS.border}){
  return <span style={{fontSize:9,padding:"2px 6px",borderRadius:99,background:bg,color,border:`0.5px solid ${border}`}}>{children}</span>;
}

async function callClaude(userMsg){
  const res=await fetch("https://api.anthropic.com/v1/messages",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:1000,messages:[{role:"user",content:userMsg}]}),
  });
  const data=await res.json();
  return data.content?.[0]?.text||"";
}

async function generateAISummary(transcript){
  const prompt=`以下は音声配信の文字起こしです。JSONのみ返してください：{"title":"タイトル20文字以内","summary":["要点1","要点2","要点3","要点4","要点5"],"category":"お金・投資かメンズ美容かキャリアのいずれか"}\n\n文字起こし：${transcript}`;
  try{ const raw=await callClaude(prompt); const m=raw.match(/\{[\s\S]*\}/); if(m)return JSON.parse(m[0]); }catch(_){}
  return null;
}
function useRecorder(){
  const [state,setState]=useState("idle");
  const [seconds,setSeconds]=useState(0);
  const [transcript,setTranscript]=useState("");
  const [aiResult,setAiResult]=useState(null);
  const [errMsg,setErrMsg]=useState("");
  const [audioUrl,setAudioUrl]=useState(null);
  const mediaRef=useRef(null);
  const chunksRef=useRef([]);
  const timerRef=useRef(null);
  const recognRef=useRef(null);

  const start=useCallback(async()=>{
    setErrMsg(""); setTranscript(""); setAiResult(null); setAudioUrl(null);
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:true});
      const mr=new MediaRecorder(stream);
      chunksRef.current=[];
      mr.ondataavailable=e=>{ if(e.data.size>0)chunksRef.current.push(e.data); };
      mr.onstop=()=>{
        const blob=new Blob(chunksRef.current,{type:"audio/webm"});
        const url=URL.createObjectURL(blob);
        setAudioUrl(url);
      };
      mr.start(200);
      mediaRef.current=mr;
      setState("recording"); setSeconds(0);
      timerRef.current=setInterval(()=>setSeconds(s=>s+1),1000);
      if("webkitSpeechRecognition"in window||"SpeechRecognition"in window){
        const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
        const r=new SR(); r.lang="ja-JP"; r.continuous=true; r.interimResults=true;
        r.onresult=e=>{ let f=""; for(let i=0;i<e.results.length;i++)f+=e.results[i][0].transcript; setTranscript(f); };
        r.start(); recognRef.current=r;
      }
    }catch(e){ setErrMsg("マイクへのアクセスが必要です。ブラウザの許可設定を確認してください。"); setState("error"); }
  },[]);

  const stop=useCallback(async()=>{
    clearInterval(timerRef.current);
    try{ recognRef.current?.stop(); }catch(_){}
    if(mediaRef.current){
      mediaRef.current.stream.getTracks().forEach(t=>t.stop());
      mediaRef.current.stop();
    }
    setState("processing");
    await new Promise(r=>setTimeout(r,1000));
    const t=transcript||"音声が録音されました。お金と投資についての配信です。";
    const result=await generateAISummary(t);
    setAiResult(result); setState("done");
  },[transcript]);

  const reset=useCallback(()=>{
    if(audioUrl)URL.revokeObjectURL(audioUrl);
    setState("idle"); setSeconds(0); setTranscript(""); setAiResult(null); setErrMsg(""); setAudioUrl(null);
  },[audioUrl]);

  return{state,seconds,transcript,aiResult,errMsg,audioUrl,start,stop,reset};
}

function AudioPlayer({audioUrl,title}){
  const audioRef=useRef(null);
  const [playing,setPlaying]=useState(false);
  const [progress,setProgress]=useState(0);
  const [duration,setDuration]=useState(0);

  useEffect(()=>{
    const audio=audioRef.current;
    if(!audio)return;
    const onTime=()=>setProgress(audio.currentTime/audio.duration*100||0);
    const onMeta=()=>setDuration(audio.duration);
    const onEnd=()=>setPlaying(false);
    audio.addEventListener("timeupdate",onTime);
    audio.addEventListener("loadedmetadata",onMeta);
    audio.addEventListener("ended",onEnd);
    return()=>{ audio.removeEventListener("timeupdate",onTime); audio.removeEventListener("loadedmetadata",onMeta); audio.removeEventListener("ended",onEnd); };
  },[audioUrl]);

  const toggle=()=>{
    const audio=audioRef.current;
    if(!audio)return;
    if(playing){ audio.pause(); setPlaying(false); }
    else{ audio.play(); setPlaying(true); }
  };

  const seek=e=>{
    const audio=audioRef.current;
    if(!audio)return;
    const rect=e.currentTarget.getBoundingClientRect();
    const pct=(e.clientX-rect.left)/rect.width;
    audio.currentTime=pct*audio.duration;
  };

  return <div style={{background:COLORS.bgDeep,borderRadius:12,padding:12,border:`0.5px solid ${COLORS.gold}`,marginBottom:12}}>
    <audio ref={audioRef} src={audioUrl} preload="metadata"/>
    <div style={{fontSize:10,color:COLORS.gold,marginBottom:8}}>録音した音声を再生</div>
    <div style={{height:3,background:COLORS.border,borderRadius:2,marginBottom:10,cursor:"pointer",overflow:"hidden"}} onClick={seek}>
      <div style={{height:"100%",width:`${progress}%`,background:COLORS.gold,borderRadius:2,transition:"width .1s"}}/>
    </div>
    <div style={{display:"flex",alignItems:"center",gap:10}}>
      <button onClick={toggle} style={{width:36,height:36,borderRadius:"50%",background:COLORS.gold,border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
        {playing
          ?<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="2" y="2" width="3" height="8" rx="1" fill={COLORS.bg}/><rect x="7" y="2" width="3" height="8" rx="1" fill={COLORS.bg}/></svg>
          :<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 2l7 4-7 4V2z" fill={COLORS.bg}/></svg>}
      </button>
      <div style={{flex:1}}>
        <div style={{fontSize:11,color:COLORS.text,marginBottom:2}}>{title||"録音した音声"}</div>
        <div style={{fontSize:10,color:COLORS.textMuted}}>{fmtSec(Math.floor(duration))}</div>
      </div>
      {playing&&<Waveform active bars={8}/>}
    </div>
  </div>;
}
function EpisodeCard({ep,onPlay,playing,onSelect}){
  return <div onClick={()=>onSelect(ep)} style={{background:COLORS.bgCard,borderRadius:14,padding:"12px 14px",marginBottom:10,border:`0.5px solid ${COLORS.border}`,cursor:"pointer"}} onMouseEnter={e=>e.currentTarget.style.borderColor=COLORS.goldDim} onMouseLeave={e=>e.currentTarget.style.borderColor=COLORS.border}>
    {ep.hasAI&&<Badge color={COLORS.gold} bg={COLORS.bgDeep} border={COLORS.goldDim}>AI要約あり</Badge>}
    {ep.isOwn&&<Badge color={COLORS.green} bg={COLORS.bgDeep} border={COLORS.green}>自分の配信</Badge>}
    {ep.audioUrl&&<Badge color={COLORS.gold} bg={COLORS.bgDeep} border={COLORS.goldDim}>再生可能</Badge>}
    <div style={{display:"flex",gap:10,margin:"8px 0"}}>
      <div style={{width:40,height:40,borderRadius:10,background:COLORS.navy,border:`0.5px solid ${COLORS.border}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><ORIOLogo size={0.85}/></div>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:13,fontWeight:500,color:COLORS.text,lineHeight:1.4,marginBottom:3}}>{ep.title}</div>
        <div style={{fontSize:11,color:COLORS.textMuted}}>{ep.creator}</div>
      </div>
    </div>
    {playing&&<Waveform active/>}
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:8}}>
      <div style={{display:"flex",gap:6,alignItems:"center"}}>
        <span style={{fontSize:11,color:COLORS.textMuted}}>{ep.duration}</span>
        <Badge>{ep.category}</Badge>
        <span style={{fontSize:11,color:COLORS.textDim}}>{ep.plays} 再生</span>
      </div>
      <button onClick={e=>{e.stopPropagation();onPlay(ep);}} style={{width:32,height:32,borderRadius:"50%",background:ep.audioUrl?COLORS.gold:COLORS.navy,border:`0.5px solid ${ep.audioUrl?COLORS.gold:COLORS.border}`,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
        {playing
          ?<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="2" y="2" width="3" height="8" rx="1" fill={COLORS.bg}/><rect x="7" y="2" width="3" height="8" rx="1" fill={COLORS.bg}/></svg>
          :<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 2l7 4-7 4V2z" fill={ep.audioUrl?COLORS.bg:COLORS.textDim}/></svg>}
      </button>
    </div>
  </div>;
}

function AISummaryPanel({ep,onClose}){
  return <div style={{background:COLORS.bgCard,borderRadius:16,padding:16,border:`0.5px solid ${COLORS.goldDim}`,marginBottom:12}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
      <div>
        <div style={{fontSize:9,color:COLORS.gold,letterSpacing:".08em",marginBottom:4}}>AI要約</div>
        <div style={{fontSize:13,fontWeight:500,color:COLORS.text,lineHeight:1.4}}>{ep.title}</div>
      </div>
      <button onClick={onClose} style={{background:"none",border:"none",color:COLORS.textMuted,cursor:"pointer",fontSize:18}}>×</button>
    </div>
    {ep.audioUrl&&<AudioPlayer audioUrl={ep.audioUrl} title={ep.title}/>}
    <div style={{borderTop:`0.5px solid ${COLORS.border}`,paddingTop:10}}>
      {ep.summary.map((s,i)=><div key={i} style={{display:"flex",gap:8,alignItems:"flex-start",marginBottom:7}}>
        <div style={{width:18,height:18,borderRadius:"50%",background:COLORS.navy,border:`0.5px solid ${COLORS.goldDim}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:9,color:COLORS.gold,fontWeight:500}}>{i+1}</div>
        <div style={{fontSize:12,color:COLORS.textMuted,lineHeight:1.5}}>{s}</div>
      </div>)}
    </div>
    <div style={{marginTop:10,paddingTop:8,borderTop:`0.5px solid ${COLORS.border}`,fontSize:10,color:COLORS.goldDim}}>✦ ORIOのAIが自動生成した要約です</div>
  </div>;
}

function PlayerBar({ep,playing,onToggle}){
  const audioRef=useRef(null);
  const [prog,setProg]=useState(0);

  useEffect(()=>{
    if(!ep?.audioUrl)return;
    const audio=new Audio(ep.audioUrl);
    audioRef.current=audio;
    audio.addEventListener("timeupdate",()=>setProg(audio.currentTime/audio.duration*100||0));
    audio.addEventListener("ended",()=>onToggle());
    return()=>{ audio.pause(); audio.src=""; };
  },[ep?.audioUrl]);

  useEffect(()=>{
    const audio=audioRef.current;
    if(!audio)return;
    if(playing)audio.play().catch(()=>{});
    else audio.pause();
  },[playing]);

  if(!ep)return null;

  return <div style={{background:COLORS.bgDeep,borderTop:`0.5px solid ${COLORS.border}`,padding:"10px 16px 14px"}}>
    <div style={{height:2,background:COLORS.border,borderRadius:1,marginBottom:10,overflow:"hidden"}}>
      <div style={{height:"100%",width:`${ep.audioUrl?prog:12}%`,background:COLORS.gold,borderRadius:1,transition:"width .3s linear"}}/>
    </div>
    <div style={{display:"flex",alignItems:"center",gap:10}}>
      <div style={{width:36,height:36,borderRadius:10,background:COLORS.navy,border:`1.5px solid ${COLORS.gold}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><ORIOLogo size={0.8}/></div>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:12,fontWeight:500,color:COLORS.text,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{ep.title}</div>
        <div style={{fontSize:10,color:COLORS.textMuted}}>{ep.audioUrl?"音声あり · "+ep.creator:ep.creator}</div>
      </div>
      <button onClick={onToggle} style={{width:36,height:36,borderRadius:"50%",background:COLORS.gold,border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
        {playing
          ?<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect x="2" y="2" width="3.5" height="9" rx="1" fill={COLORS.bg}/><rect x="7.5" y="2" width="3.5" height="9" rx="1" fill={COLORS.bg}/></svg>
          :<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M3.5 2.5l8 5-8 5V2.5z" fill={COLORS.bg}/></svg>}
      </button>
    </div>
  </div>;
}
function RecordScreen({onPublish}){
  const rec=useRecorder();
  const [title,setTitle]=useState("");
  const handlePublish=()=>{
    const t=title.trim()||rec.aiResult?.title||"新しいエピソード";
    onPublish({id:Date.now(),title:t,creator:"あなたの配信",category:rec.aiResult?.category||"お金・投資",duration:`${Math.floor(rec.seconds/60)||1}分`,plays:"0",hasAI:!!rec.aiResult,isOwn:true,audioUrl:rec.audioUrl,summary:rec.aiResult?.summary||[]});
    rec.reset(); setTitle("");
  };
  return <div style={{paddingTop:16}}>
    <div style={{fontSize:18,fontWeight:500,color:COLORS.text,marginBottom:4}}>配信する</div>
    <div style={{fontSize:12,color:COLORS.textMuted,marginBottom:24}}>あなたの本音を、耳へ届ける</div>
    {(rec.state==="idle"||rec.state==="error")&&<div style={{textAlign:"center"}}>
      <div onClick={rec.start} style={{width:110,height:110,borderRadius:"50%",background:COLORS.bgCard,border:`2px solid ${COLORS.border}`,margin:"0 auto 16px",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}>
        <svg width="42" height="42" viewBox="0 0 42 42" fill="none"><rect x="14" y="6" width="14" height="22" rx="7" stroke={COLORS.textMuted} strokeWidth="2"/><path d="M7 21c0 7.73 6.27 14 14 14s14-6.27 14-14" stroke={COLORS.textMuted} strokeWidth="2" strokeLinecap="round"/><line x1="21" y1="35" x2="21" y2="41" stroke={COLORS.textMuted} strokeWidth="2" strokeLinecap="round"/></svg>
      </div>
      <div style={{fontSize:13,color:COLORS.textMuted,marginBottom:8}}>タップして録音開始</div>
      {rec.errMsg&&<div style={{fontSize:12,color:COLORS.red,background:"#1A0808",borderRadius:10,padding:"10px 14px"}}>{rec.errMsg}</div>}
    </div>}
    {rec.state==="recording"&&<div style={{textAlign:"center"}}>
      <div onClick={rec.stop} style={{width:110,height:110,borderRadius:"50%",background:"#1A0808",border:`2px solid ${COLORS.red}`,margin:"0 auto 12px",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}>
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none"><rect x="6" y="6" width="16" height="16" rx="3" fill={COLORS.red}/></svg>
      </div>
      <div style={{fontSize:24,fontWeight:500,color:COLORS.gold,marginBottom:6}}>{fmtSec(rec.seconds)}</div>
      <div style={{fontSize:12,color:COLORS.red,marginBottom:16}}>録音中... タップで停止</div>
      <div style={{display:"flex",justifyContent:"center",marginBottom:16}}><Waveform active bars={16}/></div>
      {rec.transcript&&<div style={{background:COLORS.bgCard,borderRadius:12,padding:12,textAlign:"left",border:`0.5px solid ${COLORS.border}`}}>
        <div style={{fontSize:10,color:COLORS.gold,marginBottom:6}}>リアルタイム文字起こし</div>
        <div style={{fontSize:12,color:COLORS.textMuted,lineHeight:1.6,maxHeight:80,overflow:"hidden"}}>{rec.transcript}</div>
      </div>}
    </div>}
    {rec.state==="processing"&&<div style={{textAlign:"center",paddingTop:20}}>
      <div style={{width:70,height:70,borderRadius:"50%",background:COLORS.bgCard,border:`2px solid ${COLORS.gold}`,margin:"0 auto 16px",display:"flex",alignItems:"center",justifyContent:"center"}}><ORIOLogo size={1.3}/></div>
      <div style={{fontSize:14,color:COLORS.gold,marginBottom:6}}>AIが分析中...</div>
      <div style={{fontSize:12,color:COLORS.textMuted}}>文字起こし・要約・カテゴリを自動生成しています</div>
    </div>}
    {rec.state==="done"&&<div>
      {rec.audioUrl&&<AudioPlayer audioUrl={rec.audioUrl} title={title||rec.aiResult?.title||"録音した音声"}/>}
      {rec.aiResult&&<div style={{background:COLORS.bgCard,borderRadius:16,padding:16,border:`0.5px solid ${COLORS.goldDim}`,marginBottom:14}}>
        <div style={{fontSize:10,color:COLORS.gold,marginBottom:10}}>AI分析完了</div>
        <input value={title||rec.aiResult.title} onChange={e=>setTitle(e.target.value)} style={{width:"100%",padding:"9px 12px",borderRadius:10,background:COLORS.bgDeep,border:`0.5px solid ${COLORS.border}`,color:COLORS.text,fontSize:13,outline:"none",marginBottom:12}}/>
        {rec.aiResult.summary.map((s,i)=><div key={i} style={{display:"flex",gap:8,alignItems:"flex-start",marginBottom:6}}>
          <div style={{width:17,height:17,borderRadius:"50%",background:COLORS.navy,border:`0.5px solid ${COLORS.goldDim}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:9,color:COLORS.gold}}>{i+1}</div>
          <div style={{fontSize:12,color:COLORS.textMuted,lineHeight:1.5}}>{s}</div>
        </div>)}
      </div>}
      <button onClick={handlePublish} style={{width:"100%",padding:"13px",borderRadius:14,background:COLORS.gold,border:"none",color:COLORS.bg,fontSize:14,fontWeight:600,cursor:"pointer",marginBottom:8}}>投稿する</button>
      <button onClick={rec.reset} style={{width:"100%",padding:"10px",borderRadius:14,background:"none",border:`0.5px solid ${COLORS.border}`,color:COLORS.textMuted,fontSize:13,cursor:"pointer"}}>録音し直す</button>
    </div>}
    {rec.state==="idle"&&<div style={{background:COLORS.bgCard,borderRadius:14,padding:14,border:`0.5px solid ${COLORS.border}`,marginTop:20}}>
      <div style={{fontSize:11,color:COLORS.textMuted,marginBottom:8}}>投稿後に自動で実行されます</div>
      {["AI文字起こし・要約を自動生成","Spotify・Apple Podcastに同時配信","タグ・カテゴリを自動付与"].map((f,i)=><div key={i} style={{display:"flex",gap:8,alignItems:"center",marginBottom:6}}>
        <div style={{width:6,height:6,borderRadius:"50%",background:COLORS.gold,flexShrink:0}}/>
        <span style={{fontSize:12,color:COLORS.text}}>{f}</span>
      </div>)}
    </div>}
  </div>;
}

export default function ORIOApp(){
  const [tab,setTab]=useState("home");
  const [category,setCategory]=useState("すべて");
  const [episodes,setEpisodes]=useState(INIT_EPISODES);
  const [playingEp,setPlayingEp]=useState(null);
  const [isPlaying,setIsPlaying]=useState(false);
  const [selectedEp,setSelectedEp]=useState(null);
  const [toast,setToast]=useState("");

  const showToast=msg=>{ setToast(msg); setTimeout(()=>setToast(""),3000); };
  const handlePlay=ep=>{
    if(!ep.audioUrl){ showToast("この音声はサンプルです。自分で録音した音声は再生できます！"); return; }
    if(playingEp?.id===ep.id)setIsPlaying(p=>!p);
    else{ setPlayingEp(ep); setIsPlaying(true); }
  };
  const handlePublish=ep=>{ setEpisodes(prev=>[ep,...prev]); setTab("home"); showToast("配信を投稿しました！タップして音声を再生できます"); };
  const filtered=category==="すべて"?episodes:episodes.filter(e=>e.category===category);

  const navItems=[
    {id:"home",label:"ホーム",icon:<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M3 9.5L10 3l7 6.5V17a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/><path d="M7 18v-6h6v6" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/></svg>},
    {id:"search",label:"探す",icon:<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.4"/><path d="M13.5 13.5l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>},
    {id:"record",label:"配信",icon:<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="7" y="3" width="6" height="10" rx="3" stroke="currentColor" strokeWidth="1.4"/><path d="M4 11c0 3.31 2.69 6 6 6s6-2.69 6-6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/><line x1="10" y1="17" x2="10" y2="20" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>},
    {id:"revenue",label:"収益",icon:<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.4"/><path d="M10 6v8M8 8h3a1.5 1.5 0 010 3H8m0 0h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>},
    {id:"profile",label:"マイページ",icon:<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="7" r="3.5" stroke="currentColor" strokeWidth="1.4"/><path d="M3 18c0-3.87 3.13-7 7-7s7 3.13 7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>},
  ];

  return <div style={{background:COLORS.bg,minHeight:"100vh",display:"flex",justifyContent:"center",alignItems:"flex-start",padding:"24px 16px",fontFamily:"'Helvetica Neue',Arial,sans-serif"}}>
    <style>{`
      @keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
      @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
      *{box-sizing:border-box}
      ::-webkit-scrollbar{width:3px}
      ::-webkit-scrollbar-thumb{background:${COLORS.navy};border-radius:2px}
      input::placeholder{color:${COLORS.textDim}}
    `}</style>
    {toast&&<div style={{position:"fixed",top:20,left:"50%",transform:"translateX(-50%)",background:COLORS.gold,color:COLORS.bg,padding:"10px 20px",borderRadius:99,fontSize:13,fontWeight:500,zIndex:999}}>{toast}</div>}
    <div style={{width:"100%",maxWidth:390,background:COLORS.bgDeep,borderRadius:40,overflow:"hidden",border:`1.5px solid ${COLORS.border}`,display:"flex",flexDirection:"column",minHeight:720}}>
      <div style={{background:COLORS.bgDeep,padding:"12px 24px 6px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <span style={{fontSize:13,fontWeight:600,color:COLORS.text}}>9:41</span>
        <div style={{display:"flex",gap:3,alignItems:"flex-end"}}>{[5,8,11].map((h,i)=><div key={i} style={{width:3,height:h,background:COLORS.gold,borderRadius:1}}/>)}</div>
      </div>
      <div style={{flex:1,overflowY:"auto",padding:"0 16px"}}>
        {tab==="home"&&<div style={{animation:"fadeIn .25s ease"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"14px 0 10px"}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}><ORIOLogo size={1.1}/><span style={{fontSize:20,fontWeight:500,letterSpacing:5,color:COLORS.text}}>ORIO</span></div>
            <div style={{width:32,height:32,borderRadius:"50%",background:COLORS.navy,border:`1.5px solid ${COLORS.gold}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:500,color:COLORS.gold}}>YT</div>
          </div>
          <div style={{marginBottom:14}}>
            <div style={{fontSize:12,color:COLORS.textMuted,marginBottom:2}}>おはようございます</div>
            <div style={{fontSize:10,color:COLORS.gold}}>今日のおすすめ {filtered.length}本 更新済み</div>
          </div>
          <div style={{display:"flex",gap:6,marginBottom:14,flexWrap:"wrap"}}>
            {CATEGORIES.map(c=><button key={c} onClick={()=>setCategory(c)} style={{padding:"5px 12px",borderRadius:99,fontSize:11,fontWeight:500,border:`0.5px solid ${c===category?COLORS.gold:COLORS.border}`,background:c===category?COLORS.navy:COLORS.bgDeep,color:c===category?COLORS.gold:COLORS.textMuted,cursor:"pointer"}}>{c}</button>)}
          </div>
          {selectedEp?.hasAI&&<AISummaryPanel ep={selectedEp} onClose={()=>setSelectedEp(null)}/>}
          {filtered.map(ep=><EpisodeCard key={ep.id} ep={ep} onPlay={handlePlay} playing={playingEp?.id===ep.id&&isPlaying} onSelect={e=>setSelectedEp(e.hasAI?e:null)}/>)}
        </div>}
        {tab==="search"&&<div style={{paddingTop:16}}>
          <div style={{fontSize:18,fontWeight:500,color:COLORS.text,marginBottom:14}}>探す</div>
          <input placeholder="タイトル・クリエイターで検索..." style={{width:"100%",padding:"10px 14px",borderRadius:12,background:COLORS.bgCard,border:`0.5px solid ${COLORS.border}`,color:COLORS.text,fontSize:13,outline:"none",marginBottom:18}}/>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            {[{label:"お金・投資",color:COLORS.gold},{label:"メンズ美容",color:"#5DCAA5"},{label:"キャリア",color:"#85B7EB"},{label:"自己啓発",color:"#AFA9EC"}].map(c=><div key={c.label} onClick={()=>{setCategory(c.label);setTab("home");}} style={{background:COLORS.bgCard,borderRadius:14,padding:14,border:`0.5px solid ${COLORS.border}`,cursor:"pointer"}}>
              <div style={{width:8,height:8,borderRadius:"50%",background:c.color,marginBottom:8}}/>
              <div style={{fontSize:13,fontWeight:500,color:COLORS.text,marginBottom:3}}>{c.label}</div>
              <div style={{fontSize:11,color:COLORS.textMuted}}>{episodes.filter(e=>e.category===c.label).length}本</div>
            </div>)}
          </div>
        </div>}
        {tab==="record"&&<RecordScreen onPublish={handlePublish}/>}
        {tab==="revenue"&&<div style={{paddingTop:16}}>
          <div style={{fontSize:18,fontWeight:500,color:COLORS.text,marginBottom:16}}>収益ダッシュボード</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            {[{label:"今月の収益",val:"¥28,500",color:COLORS.gold},{label:"リスナー数",val:"1,080人",color:COLORS.text},{label:"投げ銭",val:"¥6,400",color:COLORS.text},{label:"還元率",val:"80%",color:COLORS.green},{label:"サブスク収入",val:"¥12,000",color:COLORS.text},{label:"自分の配信数",val:`${episodes.filter(e=>e.isOwn).length}本`,color:COLORS.gold}].map(m=><div key={m.label} style={{background:COLORS.bgCard,borderRadius:12,padding:12,border:`0.5px solid ${COLORS.border}`}}>
              <div style={{fontSize:10,color:COLORS.textMuted,marginBottom:4}}>{m.label}</div>
              <div style={{fontSize:17,fontWeight:500,color:m.color}}>{m.val}</div>
            </div>)}
          </div>
        </div>}
        {tab==="profile"&&<div style={{paddingTop:16}}>
          <div style={{textAlign:"center",marginBottom:20}}>
            <div style={{width:64,height:64,borderRadius:"50%",background:COLORS.navy,border:`2px solid ${COLORS.gold}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,fontWeight:500,color:COLORS.gold,margin:"0 auto 10px"}}>YT</div>
            <div style={{fontSize:16,fontWeight:500,color:COLORS.text}}>山田 タロウ</div>
            <div style={{fontSize:12,color:COLORS.textMuted,marginTop:2}}>@yamada_money</div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:16}}>
            {[{label:"配信数",val:`${episodes.filter(e=>e.isOwn).length+24}`},{label:"リスナー",val:"1.1k"},{label:"総再生",val:"18k"}].map(s=><div key={s.label} style={{background:COLORS.bgCard,borderRadius:12,padding:10,textAlign:"center",border:`0.5px solid ${COLORS.border}`}}>
              <div style={{fontSize:16,fontWeight:500,color:COLORS.gold}}>{s.val}</div>
              <div style={{fontSize:10,color:COLORS.textMuted}}>{s.label}</div>
            </div>)}
          </div>
          {["収益設定・振込先","同時配信の設定","プロフィール編集","AIアシスタント設定","プライバシー設定"].map(item=><div key={item} style={{display:"flex",alignItems:"center",gap:12,padding:"13px 14px",background:COLORS.bgCard,borderRadius:12,marginBottom:8,border:`0.5px solid ${COLORS.border}`,cursor:"pointer"}}>
            <span style={{fontSize:13,color:COLORS.text}}>{item}</span>
            <span style={{marginLeft:"auto",color:COLORS.textDim,fontSize:16}}>›</span>
          </div>)}
        </div>}
        <div style={{height:16}}/>
      </div>
      <PlayerBar ep={playingEp} playing={isPlaying} onToggle={()=>setIsPlaying(p=>!p)}/>
      <div style={{background:COLORS.bgDeep,borderTop:`0.5px solid ${COLORS.border}`,padding:"10px 0 18px",display:"flex",justifyContent:"space-around"}}>
        {navItems.map(n=><button key={n.id} onClick={()=>setTab(n.id)} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:3,background:"none",border:"none",cursor:"pointer",padding:"0 8px",color:tab===n.id?COLORS.gold:COLORS.textDim}}>
          {n.icon}
          <span style={{fontSize:9}}>{n.label}</span>
        </button>)}
      </div>
    </div>
  </div>;
}
