import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "./supabase";

const COLORS = {
  bg: "#070D1A", bgCard: "#0D1827", bgDeep: "#050B15",
  navy: "#1A2D4A", gold: "#C9A84C", goldLight: "#E8C96A",
  goldDim: "#8B6914", text: "#E8EEF8", textMuted: "#607090",
  textDim: "#3A4A60", green: "#1D9E75", border: "#1A2D4A", red: "#E24B4A",
};


const CATEGORIES = ["すべて","お金・投資","メンズ美容","キャリア"];
const TRANSCRIPT_KEY = "orio_transcript";

function fmtSec(s){ return `${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`; }

function timeAgo(dateStr){
  if(!dateStr)return "";
  const diff=(Date.now()-new Date(dateStr))/1000;
  if(diff<60)return "たった今";
  if(diff<3600)return `${Math.floor(diff/60)}分前`;
  if(diff<86400)return `${Math.floor(diff/3600)}時間前`;
  if(diff<2592000)return `${Math.floor(diff/86400)}日前`;
  if(diff<31536000)return `${Math.floor(diff/2592000)}ヶ月前`;
  return `${Math.floor(diff/31536000)}年前`;
}

const AVATAR_PALETTE=["#C9A84C","#5DCAA5","#85B7EB","#AFA9EC","#E8856A","#6AB4E8","#E87B8A","#A8D86A"];
function avatarColor(str){
  let h=0; for(let i=0;i<(str||"").length;i++) h=str.charCodeAt(i)+((h<<5)-h);
  return AVATAR_PALETTE[Math.abs(h)%AVATAR_PALETTE.length];
}

function saveTranscript(text){ try{ localStorage.setItem(TRANSCRIPT_KEY,text); }catch(_){} }
function loadTranscript(){ try{ return localStorage.getItem(TRANSCRIPT_KEY)||""; }catch(_){ return ""; } }
function clearTranscript(){ try{ localStorage.removeItem(TRANSCRIPT_KEY); }catch(_){} }

// ─── WAV エンコーダー ──────────────────────────────────────────────
function audioBufferToWav(buffer){
  const numCh=buffer.numberOfChannels;
  const sr=buffer.sampleRate;
  const len=buffer.length;
  const ab=new ArrayBuffer(44+len*numCh*2);
  const v=new DataView(ab);
  const ws=(o,s)=>{ for(let i=0;i<s.length;i++) v.setUint8(o+i,s.charCodeAt(i)); };
  ws(0,"RIFF"); v.setUint32(4,36+len*numCh*2,true); ws(8,"WAVE");
  ws(12,"fmt "); v.setUint32(16,16,true); v.setUint16(20,1,true);
  v.setUint16(22,numCh,true); v.setUint32(24,sr,true);
  v.setUint32(28,sr*numCh*2,true); v.setUint16(32,numCh*2,true);
  v.setUint16(34,16,true); ws(36,"data"); v.setUint32(40,len*numCh*2,true);
  let off=44;
  for(let i=0;i<len;i++){
    for(let ch=0;ch<numCh;ch++){
      const s=Math.max(-1,Math.min(1,buffer.getChannelData(ch)[i]));
      v.setInt16(off,s<0?s*0x8000:s*0x7FFF,true); off+=2;
    }
  }
  return new Blob([ab],{type:"audio/wav"});
}

// ─── 無音カット ────────────────────────────────────────────────────
async function cutSilence(blob){
  const THRESHOLD=0.015;      // RMS音量の閾値
  const MIN_SIL_SEC=0.5;      // この秒数以上の無音をカット
  const PAD_SEC=0.1;          // 発話前後に残すパディング
  const FRAME_SEC=0.02;       // フレームサイズ (20ms)
  try{
    const ab=await blob.arrayBuffer();
    const ctx=new AudioContext();
    const buffer=await ctx.decodeAudioData(ab);
    await ctx.close();
    const sr=buffer.sampleRate;
    const fSize=Math.floor(FRAME_SEC*sr);
    const data=buffer.getChannelData(0);
    const nFrames=Math.floor(data.length/fSize);

    // フレームごとのRMSを計算
    const rms=new Float32Array(nFrames);
    for(let f=0;f<nFrames;f++){
      let sum=0; const st=f*fSize;
      for(let i=st;i<st+fSize&&i<data.length;i++) sum+=data[i]*data[i];
      rms[f]=Math.sqrt(sum/fSize);
    }

    // 発話フレームにパディングを付けて「保持」マーク
    const padF=Math.floor(PAD_SEC/FRAME_SEC);
    const keep=new Uint8Array(nFrames);
    for(let f=0;f<nFrames;f++){
      if(rms[f]>THRESHOLD){
        const from=Math.max(0,f-padF), to=Math.min(nFrames-1,f+padF);
        for(let j=from;j<=to;j++) keep[j]=1;
      }
    }

    // 連続する「保持」区間をセグメントとして収集
    // 隣接セグメント間の無音が MIN_SIL_SEC 未満なら結合
    const minSilF=Math.floor(MIN_SIL_SEC/FRAME_SEC);
    const segs=[];
    let inSeg=false, segStart=0;
    for(let f=0;f<=nFrames;f++){
      if(f<nFrames&&keep[f]){
        if(!inSeg){ inSeg=true; segStart=f; }
      } else {
        if(inSeg){
          const gap=segs.length>0?segStart-segs[segs.length-1].end:minSilF+1;
          if(gap<minSilF&&segs.length>0){ segs[segs.length-1].end=f; }
          else{ segs.push({start:segStart,end:f}); }
          inSeg=false;
        }
      }
    }

    // セグメントがなければ元のblobをそのまま返す
    if(segs.length===0) return{blob,cutSec:0,originalSec:Math.round(buffer.duration),newSec:Math.round(buffer.duration)};

    // 保持サンプル数を合計して OfflineAudioContext を作成
    let totalSamples=0;
    for(const s of segs) totalSamples+=Math.min(s.end*fSize,buffer.length)-s.start*fSize;
    const off=new OfflineAudioContext(buffer.numberOfChannels,Math.max(1,totalSamples),sr);

    // 各セグメントをオフセットに貼り付け
    let dest=0;
    for(const seg of segs){
      const st=seg.start*fSize, en=Math.min(seg.end*fSize,buffer.length);
      const len=en-st; if(len<=0) continue;
      const sb=off.createBuffer(buffer.numberOfChannels,len,sr);
      for(let ch=0;ch<buffer.numberOfChannels;ch++) sb.getChannelData(ch).set(buffer.getChannelData(ch).subarray(st,en));
      const src=off.createBufferSource(); src.buffer=sb; src.connect(off.destination);
      src.start(dest/sr); dest+=len;
    }

    const rendered=await off.startRendering();
    const wavBlob=audioBufferToWav(rendered);
    const originalSec=Math.round(buffer.duration);
    const newSec=Math.round(rendered.duration);
    return{blob:wavBlob,cutSec:Math.max(0,originalSec-newSec),originalSec,newSec};
  }catch(e){
    console.error("無音カット失敗:",e);
    return{blob,cutSec:0,originalSec:0,newSec:0};
  }
}

async function callClaude(userMsg){
  try{
    const res=await fetch("/api/claude",{
      method:"POST",
      headers:{
        "Content-Type":"application/json",
      },
      body:JSON.stringify({
        model:"claude-haiku-4-5",
        max_tokens:1024,
        messages:[{role:"user",content:userMsg}],
      }),
    });
    const data=await res.json();
    if(data.error){ console.error("Claude APIエラー:",data.error); return ""; }
    return data.content?.[0]?.text||"";
  }catch(e){
    console.error("Claude API呼び出し失敗:",e);
    return "";
  }
}

async function generateAISummary(transcript){
  const s=JSON.parse(localStorage.getItem('orio_ai_settings')||'{}');
  const pts=s.summaryPoints||5;
  const autoCategory=s.autoCategory!==false;
  const categoryPart=autoCategory?',"category":"お金・投資かメンズ美容かキャリアのいずれか"':'';
  const summaryItems=Array.from({length:pts},(_,i)=>`"要点${i+1}"`).join(',');
  const prompt=`以下は音声配信の文字起こしです。JSONのみ返してください：{"title":"タイトル20文字以内","summary":[${summaryItems}]${categoryPart}}\n\n文字起こし：${transcript}`;
  try{ const raw=await callClaude(prompt); const m=raw.match(/\{[\s\S]*\}/); if(m)return JSON.parse(m[0]); }catch(_){}
  return null;
}

function useRecorder(){
  const [state,setState]=useState("idle");
  const [countdown,setCountdown]=useState(3);
  const [seconds,setSeconds]=useState(0);
  const [transcript,setTranscript]=useState(loadTranscript);
  const [aiResult,setAiResult]=useState(null);
  const [errMsg,setErrMsg]=useState("");
  const [audioUrl,setAudioUrl]=useState(null);
  const [audioBlob,setAudioBlob]=useState(null);
  const [cutStats,setCutStats]=useState(null);
  const mediaRef=useRef(null);
  const chunksRef=useRef([]);
  const timerRef=useRef(null);
  const recognRef=useRef(null);
  const transcriptRef=useRef(transcript);

  useEffect(()=>{ transcriptRef.current=transcript; },[transcript]);

  const start=useCallback(async()=>{
    setErrMsg(""); setTranscript(""); setAiResult(null); setAudioUrl(null); setAudioBlob(null);
    clearTranscript();
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:true});
      const mr=new MediaRecorder(stream);
      chunksRef.current=[];
      mr.ondataavailable=e=>{ if(e.data.size>0)chunksRef.current.push(e.data); };
      mr.onstop=()=>{
        const blob=new Blob(chunksRef.current,{type:"audio/webm"});
        setAudioBlob(blob);
        const url=URL.createObjectURL(blob);
        setAudioUrl(url);
      };
      // ① MediaRecorder 起動（音声データのキャプチャ開始）
      mr.start(200);
      mediaRef.current=mr;

      // ② 音声認識をカウントダウン前に起動してウォームアップ
      if("webkitSpeechRecognition"in window||"SpeechRecognition"in window){
        const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
        const r=new SR();
        r.lang="ja-JP"; r.continuous=true; r.interimResults=true;

        let accumulated="";

        r.onresult=e=>{
          // カウントダウン中は無視（録音状態でない間の誤認識を捨てる）
          if(mediaRef.current?.state!=="recording") return;
          let finalText="";
          let interimText="";
          for(let i=e.resultIndex;i<e.results.length;i++){
            if(e.results[i].isFinal){ finalText+=e.results[i][0].transcript; }
            else{ interimText+=e.results[i][0].transcript; }
          }
          if(finalText) accumulated+=finalText;
          const full=accumulated+interimText;
          setTranscript(full);
          saveTranscript(full);
        };

        const restartRecognition=()=>{
          if(mediaRef.current?.state==="recording"){
            setTimeout(()=>{ try{ r.start(); }catch(_){} },150);
          }
        };
        r.onend=restartRecognition;
        r.onerror=e=>{ if(e.error!=="aborted") restartRecognition(); };

        try{ r.start(); }catch(_){}
        recognRef.current=r;
      }

      // ③ カウントダウン 3→2→1（この3秒間で音声認識エンジンがウォームアップ）
      setState("countdown");
      for(let i=3;i>=1;i--){
        setCountdown(i);
        await new Promise(r=>setTimeout(r,1000));
      }

      // ④ カウントダウン終了 → 録音開始（音声認識は既に稼働中）
      setState("recording"); setSeconds(0);
      timerRef.current=setInterval(()=>setSeconds(s=>s+1),1000);
    }catch(e){
      setErrMsg("マイクへのアクセスが必要です。ブラウザの許可設定を確認してください。");
      setState("error");
    }
  },[]);

  const stop=useCallback(async()=>{
    clearInterval(timerRef.current);
    try{ recognRef.current?.stop(); }catch(_){}

    // MediaRecorder の onstop を Promise に変換して rawBlob を取得
    const rawBlob=await new Promise(resolve=>{
      if(mediaRef.current){
        mediaRef.current.onstop=()=>resolve(new Blob(chunksRef.current,{type:"audio/webm"}));
        mediaRef.current.stream.getTracks().forEach(t=>t.stop());
        mediaRef.current.stop();
      } else { resolve(null); }
    });

    // 無音カット処理
    if(rawBlob){
      setState("cutting");
      const{blob:processedBlob,cutSec,originalSec,newSec}=await cutSilence(rawBlob);
      setCutStats({cutSec,originalSec,newSec});
      const url=URL.createObjectURL(processedBlob);
      setAudioBlob(processedBlob);
      setAudioUrl(url);
    }

    setState("processing");
    await new Promise(r=>setTimeout(r,600));
    const t=transcriptRef.current||"音声が録音されました。お金と投資についての配信です。";
    const result=await generateAISummary(t);
    setAiResult(result);
    setState("done");
  },[]);

  const reset=useCallback(()=>{
    if(audioUrl)URL.revokeObjectURL(audioUrl);
    clearTranscript();
    setState("idle"); setSeconds(0); setTranscript(""); setAiResult(null); setErrMsg(""); setAudioUrl(null); setAudioBlob(null); setCutStats(null);
  },[audioUrl]);

  // 10分（600秒）で自動停止 ※ stop の宣言より後に置く
  useEffect(()=>{
    if(state==="recording"&&seconds>=600){ stop(); }
  },[state,seconds,stop]);

  return{state,countdown,seconds,transcript,aiResult,errMsg,audioUrl,audioBlob,cutStats,start,stop,reset};
}

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

function AudioPlayer({audioUrl,title}){
  const audioRef=useRef(null);
  const [playing,setPlaying]=useState(false);
  const [currentTime,setCurrentTime]=useState(0);
  const [duration,setDuration]=useState(0);
  const [dragging,setDragging]=useState(false);
  const barRef=useRef(null);
  const progress=duration>0?currentTime/duration*100:0;

  useEffect(()=>{
    const audio=audioRef.current;
    if(!audio)return;
    const onTime=()=>{ if(!dragging) setCurrentTime(audio.currentTime); };
    const onMeta=()=>setDuration(audio.duration||0);
    const onEnd=()=>{ setPlaying(false); setCurrentTime(0); };
    audio.addEventListener("timeupdate",onTime);
    audio.addEventListener("loadedmetadata",onMeta);
    audio.addEventListener("ended",onEnd);
    return()=>{
      audio.removeEventListener("timeupdate",onTime);
      audio.removeEventListener("loadedmetadata",onMeta);
      audio.removeEventListener("ended",onEnd);
    };
  },[audioUrl,dragging]);

  const toggle=()=>{
    const audio=audioRef.current; if(!audio)return;
    if(playing){ audio.pause(); setPlaying(false); }
    else{ audio.play(); setPlaying(true); }
  };

  const skip=(sec)=>{
    const audio=audioRef.current; if(!audio)return;
    const dur=audio.duration; if(!isFinite(dur)||dur<=0)return;
    const next=Math.max(0,Math.min(dur,audio.currentTime+sec));
    if(isFinite(next)) audio.currentTime=next;
  };

  // シークバー：クリック / ドラッグ両対応
  const getPct=(clientX)=>{
    const rect=barRef.current?.getBoundingClientRect();
    if(!rect||rect.width<=0)return 0;
    const p=(clientX-rect.left)/rect.width;
    return isFinite(p)?Math.max(0,Math.min(1,p)):0;
  };
  const safeSeek=(pct)=>{
    const audio=audioRef.current; if(!audio)return;
    const dur=audio.duration; if(!isFinite(dur)||dur<=0)return;
    const t=Math.max(0,Math.min(dur,pct*dur));
    if(isFinite(t)){ audio.currentTime=t; setCurrentTime(t); }
  };
  const onBarDown=e=>{
    setDragging(true);
    const pct=getPct(e.clientX);
    if(isFinite(duration)&&duration>0) setCurrentTime(pct*duration);
  };
  const onBarMove=e=>{
    if(!dragging)return;
    const pct=getPct(e.clientX);
    if(isFinite(duration)&&duration>0) setCurrentTime(pct*duration);
  };
  const onBarUp=e=>{
    if(!dragging)return;
    safeSeek(getPct(e.clientX));
    setDragging(false);
  };
  // タッチ対応
  const onTouchMove=e=>{
    if(!dragging)return;
    const pct=getPct(e.touches[0].clientX);
    if(isFinite(duration)&&duration>0) setCurrentTime(pct*duration);
  };
  const onTouchEnd=e=>{
    if(!dragging)return;
    safeSeek(getPct(e.changedTouches[0].clientX));
    setDragging(false);
  };

  // SVGアイコン：-15s / +15s
  const SkipIcon=({fwd})=>(
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
      {fwd
        ?<path d="M16 4a12 12 0 1 1-9.8 5.1" stroke={COLORS.textMuted} strokeWidth="1.8" strokeLinecap="round"/>
        :<path d="M16 4a12 12 0 1 0 9.8 5.1" stroke={COLORS.textMuted} strokeWidth="1.8" strokeLinecap="round"/>
      }
      {fwd
        ?<path d="M24.5 4v5.5H19" stroke={COLORS.textMuted} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
        :<path d="M7.5 4v5.5H13" stroke={COLORS.textMuted} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      }
      <text x="16" y="20" textAnchor="middle" fontSize="8" fill={COLORS.textMuted} fontFamily="system-ui,sans-serif" fontWeight="500">15</text>
    </svg>
  );

  return(
    <div style={{background:COLORS.bgDeep,borderRadius:14,padding:"14px 16px",border:`0.5px solid ${COLORS.goldDim}`,marginBottom:12}}
      onMouseMove={onBarMove} onMouseUp={onBarUp} onMouseLeave={onBarUp}>
      <audio ref={audioRef} src={audioUrl} preload="metadata"/>

      {/* タイトル */}
      <div style={{fontSize:11,fontWeight:500,color:COLORS.text,marginBottom:12,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
        {title||"音声"}
      </div>

      {/* シークバー */}
      <div ref={barRef}
        onMouseDown={onBarDown}
        onTouchStart={e=>{setDragging(true);const pct=getPct(e.touches[0].clientX);setCurrentTime(pct*(duration||0));}}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={{position:"relative",height:18,display:"flex",alignItems:"center",cursor:"pointer",marginBottom:2}}>
        {/* トラック */}
        <div style={{position:"absolute",left:0,right:0,height:4,background:COLORS.border,borderRadius:2,overflow:"hidden"}}>
          <div style={{height:"100%",width:`${progress}%`,background:COLORS.gold,borderRadius:2}}/>
        </div>
        {/* つまみ */}
        <div style={{
          position:"absolute",left:`${progress}%`,transform:"translateX(-50%)",
          width:14,height:14,borderRadius:"50%",background:COLORS.gold,
          boxShadow:`0 0 0 3px ${COLORS.bgDeep}`,
          transition:dragging?"none":"left .05s",
          pointerEvents:"none",
        }}/>
      </div>

      {/* 現在時刻 / 全体時間 */}
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:14}}>
        <span style={{fontSize:10,color:COLORS.textMuted,fontVariantNumeric:"tabular-nums"}}>{fmtSec(Math.floor(currentTime))}</span>
        <span style={{fontSize:10,color:COLORS.textDim,fontVariantNumeric:"tabular-nums"}}>{duration>0?fmtSec(Math.floor(duration)):"-:--"}</span>
      </div>

      {/* コントロール: -15  ▶/⏸  +15 */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:24}}>
        <button onClick={()=>skip(-15)} style={{background:"none",border:"none",cursor:"pointer",padding:4,opacity:0.85,lineHeight:0}} title="-15秒">
          <SkipIcon fwd={false}/>
        </button>
        <button onClick={toggle}
          style={{width:54,height:54,borderRadius:"50%",background:COLORS.gold,border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,boxShadow:`0 2px 12px ${COLORS.gold}55`}}>
          {playing
            ?<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="3" y="2" width="4" height="12" rx="1.5" fill={COLORS.bg}/><rect x="9" y="2" width="4" height="12" rx="1.5" fill={COLORS.bg}/></svg>
            :<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 2.5l10 5.5-10 5.5V2.5z" fill={COLORS.bg}/></svg>}
        </button>
        <button onClick={()=>skip(15)} style={{background:"none",border:"none",cursor:"pointer",padding:4,opacity:0.85,lineHeight:0}} title="+15秒">
          <SkipIcon fwd={true}/>
        </button>
      </div>
    </div>
  );
}

function CreatorAvatar({creator,size=40,onClick,imageUrl}){
  const initial=(creator||"?")[0];
  const color=avatarColor(creator||"");
  return(
    <div
      onClick={onClick}
      title={`${creator}のチャンネル`}
      style={{
        width:size,height:size,borderRadius:"50%",flexShrink:0,
        background:imageUrl?"transparent":`${color}22`,
        border:`1.5px solid ${imageUrl?COLORS.gold:color}`,
        display:"flex",alignItems:"center",justifyContent:"center",
        fontSize:size*0.38,fontWeight:600,color,
        cursor:onClick?"pointer":"default",userSelect:"none",
        overflow:"hidden",
      }}
    >
      {imageUrl
        ?<img src={imageUrl} alt={creator} style={{width:"100%",height:"100%",objectFit:"cover"}}/>
        :initial
      }
    </div>
  );
}

function EpisodeCard({ep,onPlay,playing,onDelete,onCreatorClick,ownAvatarUrl}){
  const [expanded,setExpanded]=useState(false);
  const [showTranscript,setShowTranscript]=useState(false);
  const canExpand=!!(ep.summary?.length>0||ep.transcript);

  return(
    <div style={{background:COLORS.bgCard,borderRadius:14,marginBottom:10,border:`0.5px solid ${expanded?COLORS.goldDim:COLORS.border}`,overflow:"hidden",transition:"border-color .15s"}}>
      {/* ── メイン行（タップで展開） ── */}
      <div
        onClick={()=>canExpand&&setExpanded(e=>!e)}
        style={{padding:"12px 14px",cursor:canExpand?"pointer":"default"}}
      >
        {/* バッジ行 */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
          <div style={{display:"flex",gap:4}}>
            {ep.hasAI&&<Badge color={COLORS.gold} bg={COLORS.bgDeep} border={COLORS.goldDim}>AI要約あり</Badge>}
            {ep.isOwn&&<Badge color={COLORS.green} bg={COLORS.bgDeep} border={COLORS.green}>自分の配信</Badge>}
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            {canExpand&&(
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" style={{transition:"transform .2s",transform:expanded?"rotate(180deg)":"rotate(0deg)",flexShrink:0}}>
                <path d="M2.5 4.5l4 4 4-4" stroke={COLORS.textDim} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
            {ep.isOwn&&onDelete&&(
              <button onClick={e=>{e.stopPropagation();onDelete(ep);}} style={{background:"none",border:"none",cursor:"pointer",padding:"2px 4px",color:COLORS.textDim,fontSize:16,lineHeight:1}}>×</button>
            )}
          </div>
        </div>

        {/* アバター＋タイトル */}
        <div style={{display:"flex",gap:10,margin:"4px 0 8px"}}>
          {ep.thumbnailUrl
            ?<div style={{position:"relative",flexShrink:0,width:52,height:52}}>
                <img src={ep.thumbnailUrl} alt="" style={{width:52,height:52,borderRadius:10,objectFit:"cover",border:`0.5px solid ${COLORS.border}`,display:"block"}}/>
                <div onClick={e=>{e.stopPropagation();onCreatorClick&&onCreatorClick(ep);}} style={{position:"absolute",bottom:-3,right:-3,width:22,height:22,borderRadius:"50%",background:COLORS.bgCard,border:`1.5px solid ${COLORS.bgCard}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",overflow:"hidden"}}>
                  <CreatorAvatar creator={ep.creator} size={20} imageUrl={ep.isOwn?ownAvatarUrl:null}/>
                </div>
              </div>
            :<CreatorAvatar creator={ep.creator} imageUrl={ep.isOwn?ownAvatarUrl:null} onClick={e=>{e.stopPropagation();onCreatorClick&&onCreatorClick(ep);}}/>
          }
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:13,fontWeight:500,color:COLORS.text,lineHeight:1.4,marginBottom:2}}>{ep.title}</div>
            <div style={{display:"flex",alignItems:"center",gap:6}}>
              <span style={{fontSize:11,color:COLORS.textMuted}}>{ep.creator}</span>
              {ep.createdAt&&<span style={{fontSize:10,color:COLORS.textDim}}>· {timeAgo(ep.createdAt)}</span>}
            </div>
          </div>
        </div>

        {playing&&<Waveform active/>}

        {/* 統計＋再生ボタン */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:6}}>
          <div style={{display:"flex",gap:6,alignItems:"center"}}>
            <span style={{fontSize:11,color:COLORS.textMuted}}>{ep.duration}</span>
            <Badge>{ep.category}</Badge>
            <span style={{fontSize:11,color:COLORS.textDim}}>{ep.plays} 再生</span>
          </div>
          <button onClick={e=>{e.stopPropagation();onPlay(ep);}} style={{width:32,height:32,borderRadius:"50%",background:COLORS.gold,border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
            {playing
              ?<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="2" y="2" width="3" height="8" rx="1" fill={COLORS.bg}/><rect x="7" y="2" width="3" height="8" rx="1" fill={COLORS.bg}/></svg>
              :<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 2l7 4-7 4V2z" fill={COLORS.bg}/></svg>}
          </button>
        </div>
      </div>

      {/* ── インライン展開パネル ── */}
      {expanded&&(
        <div style={{padding:"12px 14px 14px",borderTop:`0.5px solid ${COLORS.border}`}}>
          {ep.summary?.length>0&&(
            <div style={{marginBottom:ep.transcript?12:4}}>
              <div style={{fontSize:9,color:COLORS.gold,letterSpacing:".08em",marginBottom:8}}>✦ AI要約</div>
              {ep.summary.map((s,i)=>(
                <div key={i} style={{display:"flex",gap:8,alignItems:"flex-start",marginBottom:6}}>
                  <div style={{width:16,height:16,borderRadius:"50%",background:COLORS.navy,border:`0.5px solid ${COLORS.goldDim}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:8,color:COLORS.gold,fontWeight:600}}>{i+1}</div>
                  <div style={{fontSize:11,color:COLORS.textMuted,lineHeight:1.55}}>{s}</div>
                </div>
              ))}
            </div>
          )}
          {ep.transcript&&(
            <div style={{borderTop:ep.summary?.length>0?`0.5px solid ${COLORS.border}`:"none",paddingTop:ep.summary?.length>0?10:0}}>
              <button
                onClick={e=>{e.stopPropagation();setShowTranscript(s=>!s);}}
                style={{display:"flex",alignItems:"center",gap:6,background:"none",border:"none",cursor:"pointer",padding:0,width:"100%"}}
              >
                <span style={{fontSize:10,color:COLORS.textMuted}}>📄 文字起こし全文</span>
                <span style={{fontSize:10,color:COLORS.textDim,marginLeft:"auto"}}>{showTranscript?"▲ 閉じる":"▼ 開く"}</span>
              </button>
              {showTranscript&&(
                <div style={{fontSize:11,color:COLORS.textDim,lineHeight:1.8,marginTop:8,maxHeight:160,overflowY:"auto"}}>
                  {ep.transcript}
                </div>
              )}
            </div>
          )}
          <div style={{marginTop:10,fontSize:9,color:COLORS.goldDim}}>✦ ORIOのAIが自動生成した要約です</div>
        </div>
      )}
    </div>
  );
}

function AISummaryPanel({ep,onClose}){
  const [showTranscript,setShowTranscript]=useState(false);
  return <div style={{background:COLORS.bgCard,borderRadius:16,padding:16,border:`0.5px solid ${COLORS.goldDim}`,marginBottom:12}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
      <div>
        <div style={{fontSize:9,color:COLORS.gold,letterSpacing:".08em",marginBottom:4}}>AI要約</div>
        <div style={{fontSize:13,fontWeight:500,color:COLORS.text,lineHeight:1.4}}>{ep.title}</div>
      </div>
      <button onClick={onClose} style={{background:"none",border:"none",color:COLORS.textMuted,cursor:"pointer",fontSize:18}}>×</button>
    </div>
    {ep.summary?.length>0&&<div style={{borderTop:`0.5px solid ${COLORS.border}`,paddingTop:10}}>
      {ep.summary.map((s,i)=><div key={i} style={{display:"flex",gap:8,alignItems:"flex-start",marginBottom:7}}>
        <div style={{width:18,height:18,borderRadius:"50%",background:COLORS.navy,border:`0.5px solid ${COLORS.goldDim}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:9,color:COLORS.gold,fontWeight:500}}>{i+1}</div>
        <div style={{fontSize:12,color:COLORS.textMuted,lineHeight:1.5}}>{s}</div>
      </div>)}
    </div>}
    {ep.transcript&&<div style={{marginTop:10,borderTop:`0.5px solid ${COLORS.border}`,paddingTop:10}}>
      <button onClick={()=>setShowTranscript(s=>!s)} style={{display:"flex",alignItems:"center",gap:6,background:"none",border:"none",cursor:"pointer",padding:0,width:"100%"}}>
        <span style={{fontSize:10,color:COLORS.textMuted}}>📄 文字起こし全文</span>
        <span style={{fontSize:10,color:COLORS.textDim,marginLeft:"auto"}}>{showTranscript?"▲ 閉じる":"▼ 開く"}</span>
      </button>
      {showTranscript&&<div style={{fontSize:11,color:COLORS.textDim,lineHeight:1.8,marginTop:10,maxHeight:200,overflowY:"auto",borderTop:`0.5px solid ${COLORS.border}`,paddingTop:8}}>
        {ep.transcript}
      </div>}
    </div>}
    <div style={{marginTop:10,paddingTop:8,borderTop:`0.5px solid ${COLORS.border}`,fontSize:10,color:COLORS.goldDim}}>✦ ORIOのAIが自動生成した要約です</div>
  </div>;
}

function PlayerBar({ep,playing,onToggle}){
  const audioRef=useRef(null);
  const [currentTime,setCurrentTime]=useState(0);
  const [duration,setDuration]=useState(0);
  // dragging は ref で管理 → stale closure を回避
  const draggingRef=useRef(false);
  const barRef=useRef(null);
  const onToggleRef=useRef(onToggle);
  useEffect(()=>{ onToggleRef.current=onToggle; },[onToggle]);

  // エピソード切替でリセット
  useEffect(()=>{ setCurrentTime(0); setDuration(0); },[ep?.id]);

  // 再生/停止 + エピソード切替時の再生開始
  useEffect(()=>{
    const audio=audioRef.current; if(!audio)return;
    if(playing){ audio.play().catch(()=>{}); }
    else{ audio.pause(); }
  },[playing,ep?.audioUrl]); // ep?.audioUrl を追加 → 別エピソードに切替時も play() が呼ばれる

  // timeupdate / loadedmetadata / ended リスナー
  useEffect(()=>{
    const audio=audioRef.current;
    if(!audio||!ep?.audioUrl)return;
    const onTime=()=>{ if(!draggingRef.current&&!isNaN(audio.duration)) setCurrentTime(audio.currentTime); };
    const onMeta=()=>{ if(!isNaN(audio.duration)) setDuration(audio.duration); };
    const onEnd=()=>{ setCurrentTime(0); onToggleRef.current(); };
    audio.addEventListener('timeupdate',onTime);
    audio.addEventListener('loadedmetadata',onMeta);
    audio.addEventListener('ended',onEnd);
    return()=>{
      audio.removeEventListener('timeupdate',onTime);
      audio.removeEventListener('loadedmetadata',onMeta);
      audio.removeEventListener('ended',onEnd);
    };
  },[ep?.audioUrl]);

  // ─── skip ───────────────────────────────────────────
  const skip=(sec)=>{
    const audio=audioRef.current; if(!audio)return;
    const dur=audio.duration;
    // NaN = まだ読み込まれていない → スキップ不可
    if(isNaN(dur))return;
    // Infinity (WebM等) でも相対移動は可能、ただし 0 以下にはしない
    const next=isFinite(dur)
      ? Math.max(0,Math.min(dur,audio.currentTime+sec))
      : Math.max(0,audio.currentTime+sec);
    try{ audio.currentTime=next; setCurrentTime(next); }catch(_){}
  };

  // ─── seek helpers ────────────────────────────────────
  const getPct=(clientX)=>{
    const rect=barRef.current?.getBoundingClientRect();
    if(!rect||rect.width<=0)return null;
    const p=(clientX-rect.left)/rect.width;
    return isFinite(p)?Math.max(0,Math.min(1,p)):null;
  };
  const commitSeek=(pct)=>{
    draggingRef.current=false;
    if(pct===null)return;
    const audio=audioRef.current; if(!audio)return;
    const dur=audio.duration;
    // 有限な duration がある場合のみ %ベースシーク可能
    if(!isFinite(dur)||dur<=0)return;
    const t=Math.max(0,Math.min(dur,pct*dur));
    try{ audio.currentTime=t; setCurrentTime(t); }catch(_){}
  };

  // マウス操作（PC）
  const onBarMouseDown=e=>{
    draggingRef.current=true;
    const pct=getPct(e.clientX); if(pct===null)return;
    const audio=audioRef.current; if(!audio)return;
    const dur=audio.duration; if(!isFinite(dur)||dur<=0)return;
    setCurrentTime(pct*dur);
  };
  const onWrapMouseMove=e=>{
    if(!draggingRef.current)return;
    const pct=getPct(e.clientX); if(pct===null)return;
    const audio=audioRef.current; if(!audio)return;
    const dur=audio.duration; if(!isFinite(dur)||dur<=0)return;
    setCurrentTime(pct*dur);
  };
  const onWrapMouseUp=e=>{ commitSeek(getPct(e.clientX)); };
  const onWrapMouseLeave=e=>{ if(draggingRef.current) commitSeek(getPct(e.clientX)); };

  // タッチ操作（スマホ）— draggingRef で stale closure を回避
  const onBarTouchStart=e=>{
    draggingRef.current=true;
    const pct=getPct(e.touches[0].clientX); if(pct===null)return;
    const audio=audioRef.current; if(!audio)return;
    const dur=audio.duration; if(!isFinite(dur)||dur<=0)return;
    setCurrentTime(pct*dur);
  };
  const onBarTouchMove=e=>{
    if(!draggingRef.current)return;
    const pct=getPct(e.touches[0].clientX); if(pct===null)return;
    const audio=audioRef.current; if(!audio)return;
    const dur=audio.duration; if(!isFinite(dur)||dur<=0)return;
    setCurrentTime(pct*dur);
  };
  const onBarTouchEnd=e=>{ commitSeek(getPct(e.changedTouches[0].clientX)); };

  const prog=duration>0&&isFinite(duration)?Math.min(100,currentTime/duration*100):0;
  const durationLabel=duration<=0?"-:--":isFinite(duration)?fmtSec(Math.floor(duration)):"∞";

  if(!ep)return null;
  return(
    <div style={{background:COLORS.bgDeep,borderTop:`0.5px solid ${COLORS.border}`,padding:"8px 16px 14px"}}
      onMouseMove={onWrapMouseMove} onMouseUp={onWrapMouseUp} onMouseLeave={onWrapMouseLeave}>
      {ep.audioUrl&&<audio ref={audioRef} src={ep.audioUrl} preload="metadata"/>}

      {/* シークバー + 時間表示 */}
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
        <span style={{fontSize:9,color:COLORS.textMuted,flexShrink:0,fontVariantNumeric:"tabular-nums",minWidth:28,textAlign:"right"}}>{fmtSec(Math.floor(currentTime))}</span>
        <div ref={barRef}
          style={{flex:1,position:"relative",height:20,display:"flex",alignItems:"center",cursor:"pointer",touchAction:"none"}}
          onMouseDown={onBarMouseDown}
          onTouchStart={onBarTouchStart}
          onTouchMove={onBarTouchMove}
          onTouchEnd={onBarTouchEnd}>
          {/* トラック */}
          <div style={{position:"absolute",left:0,right:0,height:3,background:COLORS.border,borderRadius:2}}>
            <div style={{height:"100%",width:`${prog}%`,background:COLORS.gold,borderRadius:2}}/>
          </div>
          {/* つまみ */}
          <div style={{position:"absolute",left:`${prog}%`,transform:"translateX(-50%)",width:13,height:13,borderRadius:"50%",background:COLORS.gold,boxShadow:`0 0 0 2px ${COLORS.bgDeep}`,pointerEvents:"none"}}/>
        </div>
        <span style={{fontSize:9,color:COLORS.textDim,flexShrink:0,fontVariantNumeric:"tabular-nums",minWidth:28}}>{durationLabel}</span>
      </div>

      {/* コントロール行 */}
      <div style={{display:"flex",alignItems:"center",gap:8}}>
        {ep.thumbnailUrl
          ?<img src={ep.thumbnailUrl} alt="" style={{width:34,height:34,borderRadius:9,objectFit:"cover",border:`1.5px solid ${COLORS.gold}`,flexShrink:0}}/>
          :<div style={{width:34,height:34,borderRadius:9,background:COLORS.navy,border:`1.5px solid ${COLORS.gold}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><ORIOLogo size={0.75}/></div>
        }
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:12,fontWeight:500,color:COLORS.text,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{ep.title}</div>
          <div style={{fontSize:10,color:COLORS.textMuted}}>{ep.creator}</div>
        </div>
        {/* -15s */}
        <button onClick={()=>skip(-15)} style={{background:"none",border:"none",cursor:"pointer",padding:"4px 6px",display:"flex",flexDirection:"column",alignItems:"center",gap:1,color:COLORS.textMuted,flexShrink:0}}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M12 4a8 8 0 1 0 7.4 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
            <path d="M19 4v4.5h-4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span style={{fontSize:8,lineHeight:1}}>15</span>
        </button>
        {/* 再生/一時停止 */}
        <button onClick={onToggle} style={{width:38,height:38,borderRadius:"50%",background:COLORS.gold,border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
          {playing
            ?<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect x="2" y="2" width="3.5" height="9" rx="1" fill={COLORS.bg}/><rect x="7.5" y="2" width="3.5" height="9" rx="1" fill={COLORS.bg}/></svg>
            :<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M3.5 2.5l8 5-8 5V2.5z" fill={COLORS.bg}/></svg>}
        </button>
        {/* +15s */}
        <button onClick={()=>skip(15)} style={{background:"none",border:"none",cursor:"pointer",padding:"4px 6px",display:"flex",flexDirection:"column",alignItems:"center",gap:1,color:COLORS.textMuted,flexShrink:0}}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M12 4a8 8 0 1 1-7.4 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
            <path d="M5 4v4.5h4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span style={{fontSize:8,lineHeight:1}}>15</span>
        </button>
      </div>
    </div>
  );
}

const CATEGORY_OPTIONS=[
  {value:"お金・投資", color:COLORS.gold},
  {value:"メンズ美容", color:"#5DCAA5"},
  {value:"キャリア",   color:"#85B7EB"},
  {value:"自己啓発",   color:"#AFA9EC"},
  {value:"ライフスタイル", color:"#E8856A"},
  {value:"テクノロジー",  color:"#6AB4E8"},
];

function RecordScreen({onPublish}){
  const rec=useRecorder();
  const [title,setTitle]=useState("");
  const [category,setCategory]=useState("");
  const [publishing,setPublishing]=useState(false);
  const [thumbnailFile,setThumbnailFile]=useState(null);
  const [thumbnailPreview,setThumbnailPreview]=useState(null);
  const [editSummary,setEditSummary]=useState([]);
  const [editTranscript,setEditTranscript]=useState("");
  const [mode,setMode]=useState("record"); // "record" | "upload"
  // ── Upload mode state ──
  const [uploadFile,setUploadFile]=useState(null);
  const [uploadUrl,setUploadUrl]=useState(null);
  const [uploadMemo,setUploadMemo]=useState("");
  const [uploadAiResult,setUploadAiResult]=useState(null);
  const [uploadAnalyzing,setUploadAnalyzing]=useState(false);
  const [uploadDuration,setUploadDuration]=useState(0);

  // AI分析完了時に編集用stateを初期化
  useEffect(()=>{
    if(rec.state==="done"){
      setEditSummary(rec.aiResult?.summary||[]);
      setEditTranscript(rec.transcript||"");
    }
  },[rec.state]); // eslint-disable-line

  const handleThumbnailChange=e=>{
    const file=e.target.files?.[0];
    if(!file)return;
    setThumbnailFile(file);
    const reader=new FileReader();
    reader.onload=ev=>setThumbnailPreview(ev.target.result);
    reader.readAsDataURL(file);
  };

  // AIが判定したカテゴリを初期値にセット
  useEffect(()=>{
    if(rec.aiResult?.category) setCategory(rec.aiResult.category);
  },[rec.aiResult]);

  const selectedCategory=category||rec.aiResult?.category||"お金・投資";

  // uploadAiResult → フォームへ反映
  useEffect(()=>{
    if(!uploadAiResult) return;
    if(uploadAiResult.summary) setEditSummary(uploadAiResult.summary);
    if(uploadAiResult.category) setCategory(uploadAiResult.category);
    if(uploadAiResult.title&&!title) setTitle(uploadAiResult.title);
  },[uploadAiResult]); // eslint-disable-line

  const switchMode=(m)=>{
    if(m===mode) return;
    if(uploadUrl) URL.revokeObjectURL(uploadUrl);
    setUploadFile(null); setUploadUrl(null); setUploadMemo(""); setUploadAiResult(null);
    setUploadAnalyzing(false); setUploadDuration(0);
    if(rec.state!=="idle") rec.reset();
    setTitle(""); setCategory(""); setThumbnailFile(null); setThumbnailPreview(null);
    setEditSummary([]); setEditTranscript("");
    setMode(m);
  };

  const handleUploadFileChange=(e)=>{
    const file=e.target.files?.[0]; if(!file) return;
    if(uploadUrl) URL.revokeObjectURL(uploadUrl);
    const url=URL.createObjectURL(file);
    setUploadFile(file); setUploadUrl(url);
    setUploadAiResult(null); setUploadMemo(""); setEditSummary([]);
    setTitle(""); setCategory("");
    const audio=new Audio(url);
    audio.onloadedmetadata=()=>setUploadDuration(Math.round(audio.duration));
  };

  const handleUploadAnalyze=async()=>{
    if(!uploadMemo.trim()) return;
    setUploadAnalyzing(true);
    const result=await generateAISummary(uploadMemo);
    setUploadAiResult(result);
    setUploadAnalyzing(false);
  };

  const handleUploadPublish=async()=>{
    if(!uploadFile) return;
    setPublishing(true);
    const t=title.trim()||uploadAiResult?.title||uploadFile.name.replace(/\.[^.]+$/,"")||"新しいエピソード";
    await onPublish({
      title:t,
      category:category||uploadAiResult?.category||"お金・投資",
      seconds:uploadDuration,
      hasAI:!!(uploadAiResult||editSummary.length>0),
      audioUrl:uploadUrl,
      audioBlob:uploadFile,
      summary:editSummary.filter(s=>s.trim()),
      transcript:editTranscript,
      thumbnailFile,
    });
    if(uploadUrl) URL.revokeObjectURL(uploadUrl);
    setUploadFile(null); setUploadUrl(null); setUploadMemo(""); setUploadAiResult(null); setUploadDuration(0);
    setTitle(""); setThumbnailFile(null); setThumbnailPreview(null); setEditSummary([]); setEditTranscript("");
    setPublishing(false);
  };

  const handlePublish=async()=>{
    setPublishing(true);
    const t=title.trim()||rec.aiResult?.title||"新しいエピソード";
    await onPublish({
      title:t,
      category:selectedCategory,
      seconds:rec.seconds,
      hasAI:!!(rec.aiResult||editSummary.length>0),
      audioUrl:rec.audioUrl,
      audioBlob:rec.audioBlob,
      summary:editSummary.filter(s=>s.trim()),
      transcript:editTranscript,
      thumbnailFile,
    });
    rec.reset();
    setTitle("");
    setThumbnailFile(null);
    setThumbnailPreview(null);
    setEditSummary([]);
    setEditTranscript("");
    setPublishing(false);
  };

  return <div style={{paddingTop:16}}>
    <div style={{fontSize:18,fontWeight:500,color:COLORS.text,marginBottom:4}}>配信する</div>
    <div style={{fontSize:12,color:COLORS.textMuted,marginBottom:16}}>あなたの本音を、耳へ届ける</div>

    {/* ── モード切替タブ ── */}
    <div style={{display:"flex",background:COLORS.bgCard,borderRadius:12,padding:3,marginBottom:20,border:`0.5px solid ${COLORS.border}`}}>
      {[{k:"record",l:"録音する"},{k:"upload",l:"ファイルを投稿"}].map(({k,l})=>(
        <button key={k} onClick={()=>switchMode(k)}
          style={{flex:1,padding:"9px 0",borderRadius:10,border:"none",cursor:"pointer",
            background:mode===k?COLORS.navy:"transparent",
            color:mode===k?COLORS.text:COLORS.textMuted,
            fontSize:12,fontWeight:mode===k?500:400,transition:"all .15s"}}>
          {l}
        </button>
      ))}
    </div>

    {mode==="record"&&<>
    {(rec.state==="idle"||rec.state==="error")&&<div style={{textAlign:"center"}}>
      {rec.transcript&&<div style={{background:COLORS.bgCard,borderRadius:12,padding:12,textAlign:"left",border:`0.5px solid ${COLORS.goldDim}`,marginBottom:16}}>
        <div style={{fontSize:10,color:COLORS.gold,marginBottom:6}}>前回の文字起こし（保存済み）</div>
        <div style={{fontSize:12,color:COLORS.textMuted,lineHeight:1.6,maxHeight:80,overflow:"hidden"}}>{rec.transcript}</div>
        <button onClick={()=>{clearTranscript();window.location.reload();}} style={{marginTop:8,fontSize:10,color:COLORS.red,background:"none",border:"none",cursor:"pointer",padding:0}}>クリアする</button>
      </div>}
      <div onClick={rec.start} style={{width:110,height:110,borderRadius:"50%",background:COLORS.bgCard,border:`2px solid ${COLORS.border}`,margin:"0 auto 16px",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}>
        <svg width="42" height="42" viewBox="0 0 42 42" fill="none"><rect x="14" y="6" width="14" height="22" rx="7" stroke={COLORS.textMuted} strokeWidth="2"/><path d="M7 21c0 7.73 6.27 14 14 14s14-6.27 14-14" stroke={COLORS.textMuted} strokeWidth="2" strokeLinecap="round"/><line x1="21" y1="35" x2="21" y2="41" stroke={COLORS.textMuted} strokeWidth="2" strokeLinecap="round"/></svg>
      </div>
      <div style={{fontSize:13,color:COLORS.textMuted,marginBottom:8}}>タップして録音開始</div>
      {rec.errMsg&&<div style={{fontSize:12,color:COLORS.red,background:"#1A0808",borderRadius:10,padding:"10px 14px"}}>{rec.errMsg}</div>}
    </div>}

    {rec.state==="countdown"&&<div style={{textAlign:"center",paddingTop:20}}>
      <div style={{width:110,height:110,borderRadius:"50%",background:"#0D1827",border:`2px solid ${COLORS.gold}`,margin:"0 auto 16px",display:"flex",alignItems:"center",justifyContent:"center"}}>
        <span style={{fontSize:52,fontWeight:700,color:COLORS.gold,lineHeight:1}}>{rec.countdown}</span>
      </div>
      <div style={{fontSize:14,color:COLORS.gold,marginBottom:4}}>準備してください...</div>
      <div style={{fontSize:12,color:COLORS.textMuted}}>カウントダウン終了後に録音が始まります</div>
    </div>}

    {rec.state==="recording"&&<div style={{textAlign:"center"}}>
      <div onClick={rec.stop} style={{width:110,height:110,borderRadius:"50%",background:"#1A0808",border:`2px solid ${COLORS.red}`,margin:"0 auto 12px",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}>
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none"><rect x="6" y="6" width="16" height="16" rx="3" fill={COLORS.red}/></svg>
      </div>
      <div style={{fontSize:24,fontWeight:500,color:COLORS.gold,marginBottom:2}}>{fmtSec(rec.seconds)}</div>
      <div style={{fontSize:11,color:rec.seconds>=480?COLORS.red:COLORS.textMuted,marginBottom:4}}>
        残り {fmtSec(600-rec.seconds)}{rec.seconds>=540?" ⚠️ もうすぐ終了":""}
      </div>
      <div style={{fontSize:12,color:COLORS.red,marginBottom:16}}>録音中... タップで停止</div>
      <div style={{display:"flex",justifyContent:"center",marginBottom:16}}><Waveform active bars={16}/></div>
      {rec.transcript&&<div style={{background:COLORS.bgCard,borderRadius:12,padding:12,textAlign:"left",border:`0.5px solid ${COLORS.border}`}}>
        <div style={{fontSize:10,color:COLORS.gold,marginBottom:6}}>リアルタイム文字起こし（自動保存中）</div>
        <div style={{fontSize:12,color:COLORS.textMuted,lineHeight:1.6,maxHeight:80,overflow:"hidden"}}>{rec.transcript}</div>
      </div>}
    </div>}

    {rec.state==="cutting"&&<div style={{textAlign:"center",paddingTop:20}}>
      <div style={{width:70,height:70,borderRadius:"50%",background:COLORS.bgCard,border:`2px solid ${COLORS.gold}`,margin:"0 auto 16px",display:"flex",alignItems:"center",justifyContent:"center"}}>
        <svg width="30" height="30" viewBox="0 0 30 30" fill="none">
          <circle cx="8" cy="9" r="4" stroke={COLORS.gold} strokeWidth="1.6"/>
          <circle cx="8" cy="21" r="4" stroke={COLORS.gold} strokeWidth="1.6"/>
          <line x1="11.8" y1="10.5" x2="26" y2="6" stroke={COLORS.gold} strokeWidth="1.6" strokeLinecap="round"/>
          <line x1="11.8" y1="19.5" x2="26" y2="24" stroke={COLORS.gold} strokeWidth="1.6" strokeLinecap="round"/>
          <line x1="14" y1="15" x2="26" y2="15" stroke={COLORS.gold} strokeWidth="1.6" strokeLinecap="round" strokeDasharray="2 2"/>
        </svg>
      </div>
      <div style={{fontSize:14,color:COLORS.gold,marginBottom:6}}>無音カット中...</div>
      <div style={{fontSize:12,color:COLORS.textMuted}}>静かな部分を自動検出してカットしています</div>
    </div>}

    {rec.state==="processing"&&<div style={{textAlign:"center",paddingTop:20}}>
      <div style={{width:70,height:70,borderRadius:"50%",background:COLORS.bgCard,border:`2px solid ${COLORS.gold}`,margin:"0 auto 16px",display:"flex",alignItems:"center",justifyContent:"center"}}><ORIOLogo size={1.3}/></div>
      <div style={{fontSize:14,color:COLORS.gold,marginBottom:6}}>AIが分析中...</div>
      <div style={{fontSize:12,color:COLORS.textMuted}}>文字起こし・要約・カテゴリを自動生成しています</div>
    </div>}

    {rec.state==="done"&&<div>
      {rec.audioUrl&&<AudioPlayer audioUrl={rec.audioUrl} title={title||"録音した音声"}/>}

      {/* ── 無音カット結果バッジ ── */}
      {rec.cutStats&&rec.cutStats.cutSec>0&&(
        <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:12,padding:"8px 14px",borderRadius:99,background:COLORS.bgCard,border:`0.5px solid ${COLORS.goldDim}`,fontSize:11,color:COLORS.gold,width:"fit-content"}}>
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <circle cx="3" cy="3.5" r="2" stroke={COLORS.gold} strokeWidth="1.2"/>
            <circle cx="3" cy="9.5" r="2" stroke={COLORS.gold} strokeWidth="1.2"/>
            <line x1="4.8" y1="4.3" x2="12" y2="2" stroke={COLORS.gold} strokeWidth="1.2" strokeLinecap="round"/>
            <line x1="4.8" y1="8.7" x2="12" y2="11" stroke={COLORS.gold} strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
          <span>{rec.cutStats.cutSec}秒の無音をカットしました（{rec.cutStats.originalSec}秒 → {rec.cutStats.newSec}秒）</span>
        </div>
      )}

      {/* ── サムネイル選択 ── */}
      <div style={{background:COLORS.bgCard,borderRadius:14,padding:14,border:`0.5px solid ${COLORS.border}`,marginBottom:12}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
          <span style={{fontSize:11,color:COLORS.textMuted}}>サムネイル</span>
          <span style={{fontSize:9,color:COLORS.textDim,background:COLORS.bgDeep,padding:"2px 7px",borderRadius:99,border:`0.5px solid ${COLORS.border}`}}>任意</span>
        </div>
        {thumbnailPreview
          ?<div style={{display:"flex",alignItems:"center",gap:12}}>
              <img src={thumbnailPreview} alt="thumb" style={{width:72,height:72,borderRadius:12,objectFit:"cover",border:`1px solid ${COLORS.goldDim}`,flexShrink:0}}/>
              <div>
                <div style={{fontSize:11,color:COLORS.text,marginBottom:6}}>設定済み</div>
                <button onClick={()=>{setThumbnailFile(null);setThumbnailPreview(null);}} style={{fontSize:11,color:COLORS.red,background:"none",border:"none",cursor:"pointer",padding:0}}>削除する</button>
              </div>
            </div>
          :<label style={{display:"flex",alignItems:"center",gap:10,padding:"12px 14px",borderRadius:12,border:`0.5px dashed ${COLORS.border}`,cursor:"pointer",background:COLORS.bgDeep}}>
              <input type="file" accept="image/*" onChange={handleThumbnailChange} style={{display:"none"}}/>
              <div style={{width:44,height:44,borderRadius:10,background:COLORS.navy,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="1.5" y="4" width="17" height="13" rx="2" stroke={COLORS.textDim} strokeWidth="1.3"/><circle cx="7" cy="9" r="2" stroke={COLORS.textDim} strokeWidth="1.3"/><path d="M1.5 14.5l4.5-4.5 3.5 3.5 2.5-2.5 5 5" stroke={COLORS.textDim} strokeWidth="1.3" strokeLinecap="round"/></svg>
              </div>
              <div>
                <div style={{fontSize:12,color:COLORS.text,marginBottom:2}}>画像を選択する</div>
                <div style={{fontSize:10,color:COLORS.textDim}}>JPG・PNG・WEBP など</div>
              </div>
            </label>
        }
      </div>

      <div style={{background:COLORS.bgCard,borderRadius:16,padding:16,border:`0.5px solid ${rec.aiResult?COLORS.goldDim:COLORS.border}`,marginBottom:14}}>
        {rec.aiResult
          ?<div style={{fontSize:10,color:COLORS.gold,letterSpacing:".08em",marginBottom:10}}>AI分析完了 ✦</div>
          :<div style={{fontSize:10,color:COLORS.textMuted,marginBottom:10}}>タイトルを入力してください</div>
        }
        <div style={{fontSize:11,color:COLORS.textMuted,marginBottom:6}}>タイトル</div>
        <input
          value={title}
          onChange={e=>setTitle(e.target.value)}
          placeholder={rec.aiResult?.title||"エピソードのタイトルを入力..."}
          style={{width:"100%",padding:"9px 12px",borderRadius:10,background:COLORS.bgDeep,border:`0.5px solid ${COLORS.border}`,color:COLORS.text,fontSize:13,outline:"none",marginBottom:14}}
        />
        <div style={{fontSize:11,color:COLORS.textMuted,marginBottom:8}}>
          カテゴリ
          {rec.aiResult?.category&&<span style={{marginLeft:6,fontSize:9,color:COLORS.goldDim}}>✦ AIが自動判定</span>}
        </div>
        <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:4}}>
          {CATEGORY_OPTIONS.map(opt=>{
            const isSelected=selectedCategory===opt.value;
            return(
              <button
                key={opt.value}
                onClick={()=>setCategory(opt.value)}
                style={{
                  padding:"5px 12px",borderRadius:99,fontSize:11,fontWeight:500,cursor:"pointer",
                  border:`1px solid ${isSelected?opt.color:COLORS.border}`,
                  background:isSelected?`${opt.color}22`:COLORS.bgDeep,
                  color:isSelected?opt.color:COLORS.textMuted,
                  transition:"all .15s",
                }}
              >{opt.value}</button>
            );
          })}
        </div>
        <div style={{borderTop:`0.5px solid ${COLORS.border}`,paddingTop:10,marginTop:10}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <div style={{display:"flex",alignItems:"center",gap:6}}>
              <span style={{fontSize:10,color:COLORS.gold}}>AI要約</span>
              <span style={{fontSize:9,color:COLORS.textDim}}>編集・追加・削除できます</span>
            </div>
            <span style={{fontSize:9,color:COLORS.textDim}}>{editSummary.length}/7</span>
          </div>
          {editSummary.map((s,i)=>(
            <div key={i} style={{display:"flex",gap:6,alignItems:"center",marginBottom:6}}>
              <div style={{width:18,height:18,borderRadius:"50%",background:COLORS.navy,border:`0.5px solid ${COLORS.goldDim}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:9,color:COLORS.gold,fontWeight:500}}>{i+1}</div>
              <input
                value={s}
                onChange={e=>{const n=[...editSummary];n[i]=e.target.value;setEditSummary(n);}}
                placeholder={`要点 ${i+1}`}
                style={{flex:1,padding:"6px 10px",borderRadius:8,background:COLORS.bgDeep,border:`0.5px solid ${COLORS.border}`,color:COLORS.text,fontSize:11,outline:"none",fontFamily:"inherit"}}
              />
              <button onClick={()=>setEditSummary(prev=>prev.filter((_,j)=>j!==i))} style={{background:"none",border:"none",cursor:"pointer",color:COLORS.textDim,fontSize:16,padding:"0 2px",flexShrink:0,lineHeight:1}}>×</button>
            </div>
          ))}
          {editSummary.length===0&&(
            <div style={{fontSize:11,color:COLORS.textDim,marginBottom:8,padding:"6px 0"}}>要約ポイントがありません</div>
          )}
          {editSummary.length<7&&(
            <button
              onClick={()=>setEditSummary(prev=>[...prev,""])}
              style={{width:"100%",padding:"7px",borderRadius:8,background:"none",border:`0.5px dashed ${COLORS.goldDim}`,color:COLORS.gold,fontSize:11,cursor:"pointer",marginTop:2}}
            >＋ 要約ポイントを追加</button>
          )}
        </div>
        <div style={{marginTop:10,paddingTop:10,borderTop:`0.5px solid ${COLORS.border}`}}>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}>
            <span style={{fontSize:10,color:COLORS.textMuted}}>文字起こし全文</span>
            <span style={{fontSize:9,color:COLORS.textDim}}>編集できます</span>
          </div>
          <textarea
            value={editTranscript}
            onChange={e=>setEditTranscript(e.target.value)}
            placeholder="文字起こしテキストを入力・修正できます..."
            style={{
              width:"100%",padding:"8px 10px",borderRadius:10,
              background:COLORS.bgDeep,border:`0.5px solid ${COLORS.border}`,
              color:COLORS.textDim,fontSize:11,outline:"none",
              lineHeight:1.7,minHeight:72,maxHeight:160,resize:"vertical",
              fontFamily:"inherit",
            }}
          />
        </div>
        {rec.aiResult&&<div style={{marginTop:10,paddingTop:8,borderTop:`0.5px solid ${COLORS.border}`,fontSize:10,color:COLORS.goldDim}}>✦ ORIOのAIが自動生成した要約です</div>}
      </div>
      <button onClick={handlePublish} disabled={publishing||!title.trim()} style={{width:"100%",padding:"13px",borderRadius:14,background:COLORS.gold,border:"none",color:COLORS.bg,fontSize:14,fontWeight:600,cursor:"pointer",marginBottom:8,opacity:(publishing||!title.trim())?0.6:1}}>
        {publishing?"投稿中...":"投稿する"}
      </button>
      <button onClick={rec.reset} disabled={publishing} style={{width:"100%",padding:"10px",borderRadius:14,background:"none",border:`0.5px solid ${COLORS.border}`,color:COLORS.textMuted,fontSize:13,cursor:"pointer"}}>録音し直す</button>
    </div>}

    {rec.state==="idle"&&<div style={{background:COLORS.bgCard,borderRadius:14,padding:14,border:`0.5px solid ${COLORS.border}`,marginTop:20}}>
      <div style={{fontSize:11,color:COLORS.textMuted,marginBottom:8}}>投稿後に自動で実行されます</div>
      {["AI文字起こし・要約を自動生成","タグ・カテゴリを自動付与"].map((f,i)=><div key={i} style={{display:"flex",gap:8,alignItems:"center",marginBottom:6}}>
        <div style={{width:6,height:6,borderRadius:"50%",background:COLORS.gold,flexShrink:0}}/>
        <span style={{fontSize:12,color:COLORS.text}}>{f}</span>
      </div>)}
    </div>}
    </>}

    {/* ──────────────────── Upload mode UI ──────────────────── */}
    {mode==="upload"&&<>
      {/* ファイル未選択：ファイルピッカー */}
      {!uploadFile&&(
        <label style={{display:"flex",flexDirection:"column",alignItems:"center",gap:14,padding:"44px 20px",borderRadius:16,border:`1.5px dashed ${COLORS.border}`,background:COLORS.bgCard,cursor:"pointer",textAlign:"center"}}>
          <input type="file" accept="audio/*" onChange={handleUploadFileChange} style={{display:"none"}}/>
          <div style={{width:66,height:66,borderRadius:"50%",background:COLORS.bgDeep,border:`1.5px solid ${COLORS.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}>
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
              <path d="M14 4v15M9 9l5-5 5 5" stroke={COLORS.textMuted} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M4 22h20" stroke={COLORS.textMuted} strokeWidth="1.8" strokeLinecap="round"/>
            </svg>
          </div>
          <div>
            <div style={{fontSize:14,color:COLORS.text,marginBottom:4}}>音声ファイルを選択</div>
            <div style={{fontSize:11,color:COLORS.textMuted}}>MP3・WAV・M4A・AAC・OGG など</div>
          </div>
        </label>
      )}

      {/* AI分析中スピナー */}
      {uploadFile&&uploadAnalyzing&&(
        <div style={{textAlign:"center",paddingTop:20}}>
          <div style={{width:70,height:70,borderRadius:"50%",background:COLORS.bgCard,border:`2px solid ${COLORS.gold}`,margin:"0 auto 16px",display:"flex",alignItems:"center",justifyContent:"center"}}><ORIOLogo size={1.3}/></div>
          <div style={{fontSize:14,color:COLORS.gold,marginBottom:6}}>AIが分析中...</div>
          <div style={{fontSize:12,color:COLORS.textMuted}}>メモをもとに要約・タイトルを生成しています</div>
        </div>
      )}

      {/* ファイル選択済み・分析済みまたは未分析：フォーム */}
      {uploadFile&&!uploadAnalyzing&&(
        <div>
          {uploadUrl&&<AudioPlayer audioUrl={uploadUrl} title={uploadFile.name}/>}

          {/* AI分析セクション */}
          <div style={{background:COLORS.bgCard,borderRadius:14,padding:14,border:`0.5px solid ${uploadAiResult?COLORS.goldDim:COLORS.border}`,marginBottom:12}}>
            {uploadAiResult
              ?<div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                  <div style={{fontSize:10,color:COLORS.gold}}>AI分析完了 ✦</div>
                  <button onClick={()=>{setUploadAiResult(null);setEditSummary([]);setTitle("");setCategory("");setUploadMemo("");}} style={{fontSize:9,color:COLORS.textDim,background:"none",border:"none",cursor:"pointer",padding:0}}>やり直す</button>
                </div>
              :<>
                <div style={{fontSize:10,color:COLORS.textMuted,marginBottom:8}}>内容のメモを入力するとAIがタイトル・要約を生成します <span style={{color:COLORS.textDim}}>（任意）</span></div>
                <textarea
                  value={uploadMemo}
                  onChange={e=>setUploadMemo(e.target.value)}
                  placeholder={"例：新NISAの積立戦略について。月3万円から始める方法、おすすめ銘柄の選び方など話しました。"}
                  style={{width:"100%",padding:"9px 12px",borderRadius:10,background:COLORS.bgDeep,border:`0.5px solid ${COLORS.border}`,color:COLORS.text,fontSize:11,outline:"none",lineHeight:1.6,minHeight:80,resize:"vertical",fontFamily:"inherit",marginBottom:10}}
                />
                <button
                  onClick={handleUploadAnalyze}
                  disabled={!uploadMemo.trim()}
                  style={{width:"100%",padding:"9px",borderRadius:10,background:uploadMemo.trim()?`${COLORS.gold}18`:"transparent",border:`0.5px solid ${uploadMemo.trim()?COLORS.gold:COLORS.border}`,color:uploadMemo.trim()?COLORS.gold:COLORS.textDim,fontSize:12,cursor:uploadMemo.trim()?"pointer":"default",fontWeight:500}}
                >✦ AIでタイトル・要約を生成する</button>
              </>
            }
          </div>

          {/* サムネイル */}
          <div style={{background:COLORS.bgCard,borderRadius:14,padding:14,border:`0.5px solid ${COLORS.border}`,marginBottom:12}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
              <span style={{fontSize:11,color:COLORS.textMuted}}>サムネイル</span>
              <span style={{fontSize:9,color:COLORS.textDim,background:COLORS.bgDeep,padding:"2px 7px",borderRadius:99,border:`0.5px solid ${COLORS.border}`}}>任意</span>
            </div>
            {thumbnailPreview
              ?<div style={{display:"flex",alignItems:"center",gap:12}}>
                  <img src={thumbnailPreview} alt="thumb" style={{width:72,height:72,borderRadius:12,objectFit:"cover",border:`1px solid ${COLORS.goldDim}`,flexShrink:0}}/>
                  <div>
                    <div style={{fontSize:11,color:COLORS.text,marginBottom:6}}>設定済み</div>
                    <button onClick={()=>{setThumbnailFile(null);setThumbnailPreview(null);}} style={{fontSize:11,color:COLORS.red,background:"none",border:"none",cursor:"pointer",padding:0}}>削除する</button>
                  </div>
                </div>
              :<label style={{display:"flex",alignItems:"center",gap:10,padding:"12px 14px",borderRadius:12,border:`0.5px dashed ${COLORS.border}`,cursor:"pointer",background:COLORS.bgDeep}}>
                  <input type="file" accept="image/*" onChange={handleThumbnailChange} style={{display:"none"}}/>
                  <div style={{width:44,height:44,borderRadius:10,background:COLORS.navy,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="1.5" y="4" width="17" height="13" rx="2" stroke={COLORS.textDim} strokeWidth="1.3"/><circle cx="7" cy="9" r="2" stroke={COLORS.textDim} strokeWidth="1.3"/><path d="M1.5 14.5l4.5-4.5 3.5 3.5 2.5-2.5 5 5" stroke={COLORS.textDim} strokeWidth="1.3" strokeLinecap="round"/></svg>
                  </div>
                  <div>
                    <div style={{fontSize:12,color:COLORS.text,marginBottom:2}}>画像を選択する</div>
                    <div style={{fontSize:10,color:COLORS.textDim}}>JPG・PNG・WEBP など</div>
                  </div>
                </label>
            }
          </div>

          {/* タイトル・カテゴリ・要約 */}
          <div style={{background:COLORS.bgCard,borderRadius:16,padding:16,border:`0.5px solid ${uploadAiResult?COLORS.goldDim:COLORS.border}`,marginBottom:14}}>
            {uploadAiResult
              ?<div style={{fontSize:10,color:COLORS.gold,letterSpacing:".08em",marginBottom:10}}>AI分析完了 ✦</div>
              :<div style={{fontSize:10,color:COLORS.textMuted,marginBottom:10}}>タイトルを入力してください</div>
            }
            <div style={{fontSize:11,color:COLORS.textMuted,marginBottom:6}}>タイトル</div>
            <input
              value={title}
              onChange={e=>setTitle(e.target.value)}
              placeholder={uploadAiResult?.title||"エピソードのタイトルを入力..."}
              style={{width:"100%",padding:"9px 12px",borderRadius:10,background:COLORS.bgDeep,border:`0.5px solid ${COLORS.border}`,color:COLORS.text,fontSize:13,outline:"none",marginBottom:14}}
            />
            <div style={{fontSize:11,color:COLORS.textMuted,marginBottom:8}}>
              カテゴリ
              {uploadAiResult?.category&&<span style={{marginLeft:6,fontSize:9,color:COLORS.goldDim}}>✦ AIが自動判定</span>}
            </div>
            <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:4}}>
              {CATEGORY_OPTIONS.map(opt=>{
                const sel=(category||uploadAiResult?.category||"お金・投資")===opt.value;
                return(
                  <button key={opt.value} onClick={()=>setCategory(opt.value)}
                    style={{padding:"5px 12px",borderRadius:99,fontSize:11,fontWeight:500,cursor:"pointer",border:`1px solid ${sel?opt.color:COLORS.border}`,background:sel?`${opt.color}22`:COLORS.bgDeep,color:sel?opt.color:COLORS.textMuted,transition:"all .15s"}}
                  >{opt.value}</button>
                );
              })}
            </div>
            <div style={{borderTop:`0.5px solid ${COLORS.border}`,paddingTop:10,marginTop:10}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                <div style={{display:"flex",alignItems:"center",gap:6}}>
                  <span style={{fontSize:10,color:COLORS.gold}}>要約ポイント</span>
                  <span style={{fontSize:9,color:COLORS.textDim}}>編集・追加・削除できます</span>
                </div>
                <span style={{fontSize:9,color:COLORS.textDim}}>{editSummary.length}/7</span>
              </div>
              {editSummary.map((s,i)=>(
                <div key={i} style={{display:"flex",gap:6,alignItems:"center",marginBottom:6}}>
                  <div style={{width:18,height:18,borderRadius:"50%",background:COLORS.navy,border:`0.5px solid ${COLORS.goldDim}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:9,color:COLORS.gold,fontWeight:500}}>{i+1}</div>
                  <input value={s} onChange={e=>{const n=[...editSummary];n[i]=e.target.value;setEditSummary(n);}} placeholder={`要点 ${i+1}`} style={{flex:1,padding:"6px 10px",borderRadius:8,background:COLORS.bgDeep,border:`0.5px solid ${COLORS.border}`,color:COLORS.text,fontSize:11,outline:"none",fontFamily:"inherit"}}/>
                  <button onClick={()=>setEditSummary(prev=>prev.filter((_,j)=>j!==i))} style={{background:"none",border:"none",cursor:"pointer",color:COLORS.textDim,fontSize:16,padding:"0 2px",flexShrink:0,lineHeight:1}}>×</button>
                </div>
              ))}
              {editSummary.length===0&&<div style={{fontSize:11,color:COLORS.textDim,padding:"6px 0",marginBottom:4}}>要約ポイントがありません（メモを入力してAI生成できます）</div>}
              {editSummary.length<7&&<button onClick={()=>setEditSummary(prev=>[...prev,""])} style={{width:"100%",padding:"7px",borderRadius:8,background:"none",border:`0.5px dashed ${COLORS.goldDim}`,color:COLORS.gold,fontSize:11,cursor:"pointer",marginTop:2}}>＋ 要約ポイントを追加</button>}
            </div>
          </div>

          <button onClick={handleUploadPublish} disabled={publishing||!title.trim()}
            style={{width:"100%",padding:"13px",borderRadius:14,background:COLORS.gold,border:"none",color:COLORS.bg,fontSize:14,fontWeight:600,cursor:"pointer",marginBottom:8,opacity:(publishing||!title.trim())?0.6:1}}>
            {publishing?"投稿中...":"投稿する"}
          </button>
          <button
            onClick={()=>{if(uploadUrl)URL.revokeObjectURL(uploadUrl);setUploadFile(null);setUploadUrl(null);setUploadMemo("");setUploadAiResult(null);setEditSummary([]);setTitle("");setCategory("");setThumbnailFile(null);setThumbnailPreview(null);}}
            disabled={publishing}
            style={{width:"100%",padding:"10px",borderRadius:14,background:"none",border:`0.5px solid ${COLORS.border}`,color:COLORS.textMuted,fontSize:13,cursor:"pointer"}}>
            ファイルを選び直す
          </button>
        </div>
      )}
    </>}
  </div>;
}

function ChannelScreen({channelCreator,episodes,onPlay,playingEpId,isPlaying,onBack,onCreatorClick,followed,onToggleFollow,ownHeaderUrl,ownAvatarUrl,userId}){
  const color=avatarColor(channelCreator.creator||"");
  const channelEps=episodes.filter(e=>e.creatorId===channelCreator.creatorId);
  const isOwnChannel=channelCreator.creatorId===userId;
  const isFollowed=followed?.has(channelCreator.creatorId);

  return(
    <div style={{paddingTop:0}}>
      {/* ── ヘッダーバナー（アバターをoverflow:hiddenの外に出す） ── */}
      <div style={{position:"relative",marginBottom:52}}>
        {/* バナー画像（overflow:hiddenで角丸） */}
        <div style={{borderRadius:16,overflow:"hidden",height:120}}>
          {isOwnChannel&&ownHeaderUrl
            ?<img src={ownHeaderUrl} alt="" style={{width:"100%",height:120,objectFit:"cover",display:"block"}}/>
            :<div style={{width:"100%",height:120,background:`linear-gradient(135deg, ${color}44 0%, ${COLORS.bgDeep} 100%)`}}/>
          }
          {/* 戻るボタン（バナー上に重ねる） */}
          <button onClick={onBack} style={{position:"absolute",top:10,left:10,display:"flex",alignItems:"center",gap:4,background:"rgba(5,11,21,.72)",border:"none",cursor:"pointer",color:COLORS.text,fontSize:11,padding:"6px 10px",borderRadius:99,backdropFilter:"blur(4px)"}}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            戻る
          </button>
        </div>
        {/* アバター（バナーの外側に配置→クリップされない） */}
        <div style={{position:"absolute",bottom:-32,left:14}}>
          <div style={{padding:3,borderRadius:"50%",background:COLORS.bgDeep,display:"inline-flex"}}>
            {isOwnChannel&&ownAvatarUrl
              ?<div style={{width:62,height:62,borderRadius:"50%",border:`2px solid ${COLORS.gold}`,overflow:"hidden",display:"flex",alignItems:"center",justifyContent:"center"}}>
                  <img src={ownAvatarUrl} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                </div>
              :<CreatorAvatar creator={channelCreator.creator} size={62}/>
            }
          </div>
        </div>
      </div>

      {/* ── クリエイター情報 + フォローボタン ── */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
        <div>
          <div style={{fontSize:16,fontWeight:500,color:COLORS.text,marginBottom:3}}>{channelCreator.creator}</div>
          <div style={{fontSize:11,color:COLORS.textMuted}}>{channelEps.length}本の配信{isFollowed?" · 登録済み":""}</div>
        </div>
        {!isOwnChannel&&(
          <button
            onClick={()=>onToggleFollow?.(channelCreator.creatorId)}
            style={{
              padding:"8px 16px",borderRadius:99,fontSize:12,fontWeight:600,cursor:"pointer",
              border:`1.5px solid ${isFollowed?COLORS.border:COLORS.gold}`,
              background:isFollowed?COLORS.bgCard:COLORS.gold,
              color:isFollowed?COLORS.textMuted:COLORS.bg,
              transition:"all .15s",whiteSpace:"nowrap",flexShrink:0,
            }}
          >{isFollowed?"登録済み ✓":"リスナー登録"}</button>
        )}
      </div>

      {/* ── 統計 ── */}
      <div style={{display:"flex",gap:20,marginBottom:20}}>
        <div style={{textAlign:"center"}}>
          <div style={{fontSize:14,fontWeight:500,color}}>
            {channelEps.reduce((s,e)=>{
              const n=parseFloat((e.plays||"0").replace("k",""))*((e.plays||"").includes("k")?1000:1);
              return s+n;
            },0).toLocaleString()}
          </div>
          <div style={{fontSize:10,color:COLORS.textDim}}>総再生</div>
        </div>
        <div style={{width:1,background:COLORS.border}}/>
        <div style={{textAlign:"center"}}>
          <div style={{fontSize:14,fontWeight:500,color}}>{channelEps.length}</div>
          <div style={{fontSize:10,color:COLORS.textDim}}>配信数</div>
        </div>
      </div>

      <div style={{borderTop:`0.5px solid ${COLORS.border}`,marginBottom:14}}/>
      <div style={{fontSize:11,color:COLORS.textMuted,marginBottom:10}}>すべての配信</div>
      {channelEps.length===0
        ?<div style={{textAlign:"center",padding:"30px 0",color:COLORS.textDim,fontSize:12}}>配信がありません</div>
        :channelEps.map(ep=>(
          <EpisodeCard key={ep.id} ep={ep} onPlay={onPlay} playing={playingEpId===ep.id&&isPlaying} onCreatorClick={onCreatorClick} ownAvatarUrl={ownAvatarUrl}/>
        ))
      }
    </div>
  );
}

function AuthScreen(){
  const [mode,setMode]=useState("login");
  const [email,setEmail]=useState("");
  const [password,setPassword]=useState("");
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const [message,setMessage]=useState("");

  const handleSubmit=async()=>{
    if(!email||!password)return;
    setLoading(true); setError(""); setMessage("");
    try{
      if(mode==="signup"){
        const {error}=await supabase.auth.signUp({email,password});
        if(error)throw error;
        setMessage("確認メールを送信しました。メールのリンクをクリックしてください。");
      }else{
        const {error}=await supabase.auth.signInWithPassword({email,password});
        if(error)throw error;
      }
    }catch(e){
      setError(e.message);
    }
    setLoading(false);
  };

  return(
    <div style={{background:COLORS.bg,minHeight:"100vh",display:"flex",justifyContent:"center",alignItems:"center",padding:"24px 16px",fontFamily:"'Helvetica Neue',Arial,sans-serif"}}>
      <style>{`*{box-sizing:border-box} input::placeholder{color:${COLORS.textDim}}`}</style>
      <div style={{width:"100%",maxWidth:390,background:COLORS.bgDeep,borderRadius:40,padding:"44px 28px 36px",border:`1.5px solid ${COLORS.border}`}}>
        <div style={{textAlign:"center",marginBottom:36}}>
          <div style={{display:"flex",justifyContent:"center",marginBottom:14}}><ORIOLogo size={2}/></div>
          <div style={{fontSize:26,fontWeight:500,letterSpacing:7,color:COLORS.text,marginBottom:6}}>ORIO</div>
          <div style={{fontSize:12,color:COLORS.textMuted}}>あなたの本音を、耳へ届ける</div>
        </div>

        <div style={{marginBottom:16}}>
          <div style={{fontSize:11,color:COLORS.textMuted,marginBottom:6}}>メールアドレス</div>
          <input
            type="email" value={email} onChange={e=>setEmail(e.target.value)}
            placeholder="example@email.com"
            style={{width:"100%",padding:"12px 14px",borderRadius:12,background:COLORS.bgCard,border:`0.5px solid ${COLORS.border}`,color:COLORS.text,fontSize:14,outline:"none"}}
          />
        </div>

        <div style={{marginBottom:24}}>
          <div style={{fontSize:11,color:COLORS.textMuted,marginBottom:6}}>パスワード</div>
          <input
            type="password" value={password} onChange={e=>setPassword(e.target.value)}
            placeholder="8文字以上"
            onKeyDown={e=>e.key==="Enter"&&handleSubmit()}
            style={{width:"100%",padding:"12px 14px",borderRadius:12,background:COLORS.bgCard,border:`0.5px solid ${COLORS.border}`,color:COLORS.text,fontSize:14,outline:"none"}}
          />
        </div>

        {error&&<div style={{background:"#1A0808",border:`0.5px solid ${COLORS.red}`,borderRadius:10,padding:"10px 14px",fontSize:12,color:COLORS.red,marginBottom:16}}>{error}</div>}
        {message&&<div style={{background:"#081A10",border:`0.5px solid ${COLORS.green}`,borderRadius:10,padding:"10px 14px",fontSize:12,color:COLORS.green,marginBottom:16}}>{message}</div>}

        <button
          onClick={handleSubmit} disabled={loading}
          style={{width:"100%",padding:"14px",borderRadius:14,background:COLORS.gold,border:"none",color:COLORS.bg,fontSize:14,fontWeight:600,cursor:"pointer",marginBottom:12,opacity:loading?0.7:1}}
        >
          {loading?"処理中...":(mode==="login"?"ログイン":"アカウント作成")}
        </button>

        <button
          onClick={()=>{setMode(m=>m==="login"?"signup":"login");setError("");setMessage("");}}
          style={{width:"100%",padding:"12px",borderRadius:14,background:"none",border:`0.5px solid ${COLORS.border}`,color:COLORS.textMuted,fontSize:13,cursor:"pointer"}}
        >
          {mode==="login"?"アカウントをお持ちでない方はこちら":"すでにアカウントをお持ちの方"}
        </button>
      </div>
    </div>
  );
}

export default function ORIOApp(){
  const [user,setUser]=useState(null);
  const [authLoading,setAuthLoading]=useState(true);

  useEffect(()=>{
    supabase.auth.getSession().then(({data:{session}})=>{
      setUser(session?.user??null);
      setAuthLoading(false);
    });
    const {data:{subscription}}=supabase.auth.onAuthStateChange((_,session)=>{
      setUser(session?.user??null);
    });
    return()=>subscription.unsubscribe();
  },[]);

  if(authLoading) return(
    <div style={{background:COLORS.bg,minHeight:"100vh",display:"flex",justifyContent:"center",alignItems:"center"}}>
      <ORIOLogo size={2}/>
    </div>
  );
  if(!user) return <AuthScreen/>;
  return <MainApp user={user}/>;
}

function MainApp({user}){
  const [tab,setTab]=useState("home");
  const [channelCreator,setChannelCreator]=useState(null);
  const [profilePage,setProfilePage]=useState(null);
  const [displayName,setDisplayName]=useState("");
  const [aiSettings,setAiSettings]=useState(()=>{
    try{ return JSON.parse(localStorage.getItem('orio_ai_settings'))||{summaryPoints:5,transcriptLang:'ja-JP',autoCategory:true}; }
    catch{ return {summaryPoints:5,transcriptLang:'ja-JP',autoCategory:true}; }
  });
  const [privacySettings,setPrivacySettings]=useState(()=>{
    try{ return JSON.parse(localStorage.getItem('orio_privacy_settings'))||{publicProfile:true,showPlays:true,showActivity:false}; }
    catch{ return {publicProfile:true,showPlays:true,showActivity:false}; }
  });
  const [category,setCategory]=useState("すべて");
  const [userEpisodes,setUserEpisodes]=useState([]);
  const [loadingEpisodes,setLoadingEpisodes]=useState(true);
  const [playingEp,setPlayingEp]=useState(null);
  const [isPlaying,setIsPlaying]=useState(false);
  const [searchQuery,setSearchQuery]=useState("");
  const [toast,setToast]=useState("");
  const [headerUrl,setHeaderUrl]=useState(null);
  const [avatarUrl,setAvatarUrl]=useState(null);
  const [followed,setFollowed]=useState(()=>{
    try{ return new Set(JSON.parse(localStorage.getItem('orio_follows')||'[]')); }
    catch{ return new Set(); }
  });

  useEffect(()=>{ fetchUserEpisodes(); },[]);

  const fetchUserEpisodes=async()=>{
    await supabase.from('profiles').upsert({id:user.id},{onConflict:'id'});
    const {data:prof}=await supabase.from('profiles').select('display_name,header_url,avatar_url').eq('id',user.id).single();
    if(prof?.display_name) setDisplayName(prof.display_name);
    if(prof?.header_url) setHeaderUrl(prof.header_url);
    if(prof?.avatar_url) setAvatarUrl(prof.avatar_url);
    const {data}=await supabase.from('episodes').select('*').eq('user_id',user.id).order('created_at',{ascending:false});
    const ownName=prof?.display_name||"ユーザー";
    if(data){
      setUserEpisodes(data.map(ep=>({
        id:ep.id,
        title:ep.title,
        creator:ownName,
        category:ep.category,
        duration:`${Math.floor(ep.duration_seconds/60)||1}分`,
        plays:String(ep.plays),
        hasAI:ep.has_ai,
        isOwn:true,
        audioPath:ep.audio_path,
        audioUrl:null,
        createdAt:ep.created_at||"",
        creatorId:ep.user_id,
        summary:ep.summary||[],
        transcript:ep.transcript||"",
        thumbnailUrl:ep.thumbnail_url||null,
      })));
    }
    setLoadingEpisodes(false);
  };

  const showToast=msg=>{ setToast(msg); setTimeout(()=>setToast(""),3500); };

  const handlePlay=async(ep)=>{
    if(!ep.audioPath&&!ep.audioUrl){ showToast("サンプル音声は再生できません。自分で録音した音声は再生できます！"); return; }
    if(playingEp?.id===ep.id){ setIsPlaying(p=>!p); return; }

    let playEp=ep;
    if(ep.audioPath&&!ep.audioUrl){
      const {data}=await supabase.storage.from('audio-files').createSignedUrl(ep.audioPath,3600);
      if(data?.signedUrl){
        playEp={...ep,audioUrl:data.signedUrl};
        setUserEpisodes(prev=>prev.map(e=>e.id===ep.id?playEp:e));
      }
    }
    setPlayingEp(playEp);
    setIsPlaying(true);
  };

  const handlePublish=async(ep)=>{
    let audioPath=null;
    let signedUrl=null;
    if(ep.audioBlob){
      try{
        const mimeType=ep.audioBlob.type||'audio/webm';
        const ext=mimeType.includes('wav')?'wav':mimeType.includes('mp4')||mimeType.includes('m4a')?'m4a':'webm';
        const path=`${user.id}/${Date.now()}.${ext}`;
        const {error}=await supabase.storage.from('audio-files').upload(path,ep.audioBlob,{contentType:mimeType});
        if(!error){
          audioPath=path;
          const {data:urlData}=await supabase.storage.from('audio-files').createSignedUrl(path,3600);
          signedUrl=urlData?.signedUrl||null;
        }
      }catch(_){}
    }

    // サムネイルアップロード（1年間有効な署名付きURL）
    let thumbnailUrl=null;
    if(ep.thumbnailFile){
      try{
        const ext=ep.thumbnailFile.type.split('/')[1]||'jpg';
        const thumbPath=`${user.id}/thumbnails/${Date.now()}.${ext}`;
        const {error:te}=await supabase.storage.from('audio-files').upload(thumbPath,ep.thumbnailFile,{contentType:ep.thumbnailFile.type});
        if(!te){
          const {data:td}=await supabase.storage.from('audio-files').createSignedUrl(thumbPath,31536000);
          thumbnailUrl=td?.signedUrl||null;
        }
      }catch(_){}
    }

    const insertData={
      user_id:user.id,
      title:ep.title,
      category:ep.category,
      duration_seconds:ep.seconds,
      audio_path:audioPath,
      summary:ep.summary,
      transcript:ep.transcript,
      has_ai:ep.hasAI,
    };
    if(thumbnailUrl) insertData.thumbnail_url=thumbnailUrl;

    const {data,error}=await supabase.from('episodes').insert(insertData).select().single();

    if(error){
      console.error("投稿エラー詳細:", error);
      showToast(`投稿に失敗しました: ${error.message||error.code||"不明なエラー"}`);
      return;
    }
    if(data){
      setUserEpisodes(prev=>[{
        id:data.id,
        title:data.title,
        creator:"あなたの配信",
        category:data.category,
        duration:`${Math.floor(data.duration_seconds/60)||1}分`,
        plays:"0",
        hasAI:data.has_ai,
        isOwn:true,
        audioPath:data.audio_path,
        audioUrl:signedUrl,
        createdAt:data.created_at||new Date().toISOString(),
        creatorId:user.id,
        summary:data.summary||[],
        transcript:data.transcript||"",
        thumbnailUrl:data.thumbnail_url||thumbnailUrl||null,
      },...prev]);
    }
    setTab("home");
    showToast("配信を投稿しました！✅");
  };

  const handleDelete=async(ep)=>{
    if(!window.confirm(`「${ep.title}」を削除しますか？`))return;
    await supabase.from('episodes').delete().eq('id',ep.id);
    if(ep.audioPath) await supabase.storage.from('audio-files').remove([ep.audioPath]);
    setUserEpisodes(prev=>prev.filter(e=>e.id!==ep.id));
    if(playingEp?.id===ep.id){ setPlayingEp(null); setIsPlaying(false); }
    showToast("配信を削除しました");
  };

  const handleCreatorClick=(ep)=>{
    setChannelCreator({creatorId:ep.creatorId,creator:ep.creator});
    setTab("channel");
  };

  const handleSignOut=async()=>{ await supabase.auth.signOut(); };

  const handleSaveDisplayName=async()=>{
    const name=displayName.trim();
    if(!name) return;
    await supabase.from('profiles').upsert({id:user.id,display_name:name},{onConflict:'id'});
    setProfilePage(null);
    showToast("プロフィールを保存しました！");
  };

  // aiSettings / privacySettings の変更を localStorage に自動保存
  useEffect(()=>{ localStorage.setItem('orio_ai_settings',JSON.stringify(aiSettings)); },[aiSettings]);
  useEffect(()=>{ localStorage.setItem('orio_privacy_settings',JSON.stringify(privacySettings)); },[privacySettings]);

  // 表示名が変わったら自分のエピソードカードの creator 名も更新
  useEffect(()=>{
    if(!displayName) return;
    setUserEpisodes(prev=>prev.map(ep=>({...ep,creator:displayName})));
  },[displayName]);

  const handleHeaderChange=async(e)=>{
    const file=e.target.files?.[0];
    if(!file) return;
    // プレビューを即時表示
    const reader=new FileReader();
    reader.onload=ev=>setHeaderUrl(ev.target.result);
    reader.readAsDataURL(file);
    // Supabase Storage にアップロード
    try{
      const ext=file.type.split('/')[1]||'jpg';
      const path=`${user.id}/header.${ext}`;
      await supabase.storage.from('audio-files').upload(path,file,{contentType:file.type,upsert:true});
      const {data}=await supabase.storage.from('audio-files').createSignedUrl(path,31536000);
      if(data?.signedUrl){
        await supabase.from('profiles').upsert({id:user.id,header_url:data.signedUrl},{onConflict:'id'});
        setHeaderUrl(data.signedUrl);
      }
      showToast("ヘッダー画像を更新しました！");
    }catch(_){ showToast("画像のアップロードに失敗しました"); }
  };

  const handleAvatarChange=async(e)=>{
    const file=e.target.files?.[0];
    if(!file) return;
    const reader=new FileReader();
    reader.onload=ev=>setAvatarUrl(ev.target.result);
    reader.readAsDataURL(file);
    try{
      const ext=file.type.split('/')[1]||'jpg';
      const path=`${user.id}/avatar.${ext}`;
      await supabase.storage.from('audio-files').upload(path,file,{contentType:file.type,upsert:true});
      const {data}=await supabase.storage.from('audio-files').createSignedUrl(path,31536000);
      if(data?.signedUrl){
        await supabase.from('profiles').upsert({id:user.id,avatar_url:data.signedUrl},{onConflict:'id'});
        setAvatarUrl(data.signedUrl);
      }
      showToast("アイコンを更新しました！");
    }catch(_){ showToast("画像のアップロードに失敗しました"); }
  };

  const toggleFollow=(creatorId)=>{
    setFollowed(prev=>{
      const next=new Set(prev);
      if(next.has(creatorId)) next.delete(creatorId);
      else next.add(creatorId);
      localStorage.setItem('orio_follows',JSON.stringify([...next]));
      return next;
    });
  };

  const allEpisodes=[...userEpisodes];
  const filtered=category==="すべて"?allEpisodes:allEpisodes.filter(e=>e.category===category);

  const navItems=[
    {id:"home",label:"ホーム",icon:<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M3 9.5L10 3l7 6.5V17a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/><path d="M7 18v-6h6v6" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/></svg>},
    {id:"search",label:"探す",icon:<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.4"/><path d="M13.5 13.5l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>},
    {id:"record",label:"配信",icon:<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="7" y="3" width="6" height="10" rx="3" stroke="currentColor" strokeWidth="1.4"/><path d="M4 11c0 3.31 2.69 6 6 6s6-2.69 6-6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/><line x1="10" y1="17" x2="10" y2="20" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>},
    {id:"revenue",label:"収益",icon:<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.4"/><path d="M10 6v8M8 8h3a1.5 1.5 0 010 3H8m0 0h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>},
    {id:"profile",label:"マイページ",icon:<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="7" r="3.5" stroke="currentColor" strokeWidth="1.4"/><path d="M3 18c0-3.87 3.13-7 7-7s7 3.13 7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>},
  ];

  const userInitial=displayName?.[0]?.toUpperCase()||"U";

  return <div style={{background:COLORS.bg,minHeight:"100vh",display:"flex",justifyContent:"center",alignItems:"flex-start",padding:"24px 16px",fontFamily:"'Helvetica Neue',Arial,sans-serif"}}>
    <style>{`
      @keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
      @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
      *{box-sizing:border-box}
      ::-webkit-scrollbar{width:3px}
      ::-webkit-scrollbar-thumb{background:${COLORS.navy};border-radius:2px}
      input::placeholder{color:${COLORS.textDim}}
    `}</style>

    {toast&&<div style={{position:"fixed",top:20,left:"50%",transform:"translateX(-50%)",background:COLORS.gold,color:COLORS.bg,padding:"10px 20px",borderRadius:99,fontSize:13,fontWeight:500,zIndex:999,whiteSpace:"nowrap"}}>{toast}</div>}

    <div style={{width:"100%",maxWidth:390,background:COLORS.bgDeep,borderRadius:40,overflow:"hidden",border:`1.5px solid ${COLORS.border}`,display:"flex",flexDirection:"column",minHeight:720}}>
      <div style={{background:COLORS.bgDeep,padding:"12px 24px 6px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <span style={{fontSize:13,fontWeight:600,color:COLORS.text}}>9:41</span>
        <div style={{display:"flex",gap:3,alignItems:"flex-end"}}>{[5,8,11].map((h,i)=><div key={i} style={{width:3,height:h,background:COLORS.gold,borderRadius:1}}/>)}</div>
      </div>

      <div style={{flex:1,overflowY:"auto",padding:"0 16px"}}>
        {tab==="home"&&<div style={{animation:"fadeIn .25s ease"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"14px 0 10px"}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}><ORIOLogo size={1.1}/><span style={{fontSize:20,fontWeight:500,letterSpacing:5,color:COLORS.text}}>ORIO</span></div>
            <div style={{width:32,height:32,borderRadius:"50%",background:COLORS.navy,border:`1.5px solid ${COLORS.gold}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:500,color:COLORS.gold}}>{userInitial}</div>
          </div>
          <div style={{marginBottom:14}}>
            <div style={{fontSize:12,color:COLORS.textMuted,marginBottom:2}}>おはようございます</div>
            <div style={{fontSize:10,color:COLORS.gold}}>今日のおすすめ {filtered.length}本 更新済み</div>
          </div>
          <div style={{display:"flex",gap:6,marginBottom:14,flexWrap:"wrap"}}>
            {CATEGORIES.map(c=><button key={c} onClick={()=>setCategory(c)} style={{padding:"5px 12px",borderRadius:99,fontSize:11,fontWeight:500,border:`0.5px solid ${c===category?COLORS.gold:COLORS.border}`,background:c===category?COLORS.navy:COLORS.bgDeep,color:c===category?COLORS.gold:COLORS.textMuted,cursor:"pointer"}}>{c}</button>)}
          </div>
          {loadingEpisodes
            ?<div style={{textAlign:"center",padding:"30px 0",color:COLORS.textMuted,fontSize:12}}>読み込み中...</div>
            :filtered.map(ep=><EpisodeCard key={ep.id} ep={ep} onPlay={handlePlay} playing={playingEp?.id===ep.id&&isPlaying} onDelete={handleDelete} onCreatorClick={handleCreatorClick} ownAvatarUrl={avatarUrl}/>)
          }
        </div>}

        {tab==="channel"&&channelCreator&&<ChannelScreen
          channelCreator={channelCreator}
          episodes={allEpisodes}
          onPlay={handlePlay}
          playingEpId={playingEp?.id}
          isPlaying={isPlaying}
          onBack={()=>{ setTab("home"); setChannelCreator(null); }}
          onCreatorClick={handleCreatorClick}
          followed={followed}
          onToggleFollow={toggleFollow}
          ownHeaderUrl={headerUrl}
          ownAvatarUrl={avatarUrl}
          userId={user.id}
        />}

        {tab==="search"&&(()=>{
          const q=searchQuery.trim().toLowerCase();
          const results=q
            ?allEpisodes.filter(e=>
                e.title.toLowerCase().includes(q)||
                e.creator.toLowerCase().includes(q)||
                e.category.toLowerCase().includes(q)
              )
            :[];
          return(
            <div style={{paddingTop:16}}>
              <div style={{fontSize:18,fontWeight:500,color:COLORS.text,marginBottom:14}}>探す</div>

              {/* 検索バー */}
              <div style={{position:"relative",marginBottom:18}}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",pointerEvents:"none"}}>
                  <circle cx="6" cy="6" r="4" stroke={COLORS.textDim} strokeWidth="1.4"/>
                  <path d="M9.5 9.5l2.5 2.5" stroke={COLORS.textDim} strokeWidth="1.4" strokeLinecap="round"/>
                </svg>
                <input
                  value={searchQuery}
                  onChange={e=>setSearchQuery(e.target.value)}
                  placeholder="タイトル・クリエイター・カテゴリで検索..."
                  style={{width:"100%",padding:"10px 36px 10px 34px",borderRadius:12,background:COLORS.bgCard,border:`0.5px solid ${q?COLORS.gold:COLORS.border}`,color:COLORS.text,fontSize:13,outline:"none"}}
                />
                {q&&(
                  <button onClick={()=>setSearchQuery("")} style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",cursor:"pointer",color:COLORS.textDim,fontSize:16,lineHeight:1,padding:2}}>×</button>
                )}
              </div>

              {/* 検索結果 */}
              {q?(
                <div>
                  <div style={{fontSize:11,color:COLORS.textMuted,marginBottom:12}}>
                    「{searchQuery}」の検索結果 <span style={{color:COLORS.gold,fontWeight:500}}>{results.length}件</span>
                  </div>
                  {results.length===0
                    ?<div style={{textAlign:"center",padding:"40px 0"}}>
                        <div style={{fontSize:32,marginBottom:12}}>🔍</div>
                        <div style={{fontSize:13,color:COLORS.textMuted,marginBottom:6}}>見つかりませんでした</div>
                        <div style={{fontSize:11,color:COLORS.textDim}}>別のキーワードで試してみてください</div>
                      </div>
                    :results.map(ep=>(
                        <EpisodeCard key={ep.id} ep={ep} onPlay={handlePlay} playing={playingEp?.id===ep.id&&isPlaying} onDelete={handleDelete} onCreatorClick={handleCreatorClick} ownAvatarUrl={avatarUrl}/>
                      ))
                  }
                </div>
              ):(
                /* カテゴリグリッド（未入力時） */
                <div>
                  <div style={{fontSize:11,color:COLORS.textMuted,marginBottom:10}}>カテゴリから探す</div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                    {[{label:"お金・投資",color:COLORS.gold},{label:"メンズ美容",color:"#5DCAA5"},{label:"キャリア",color:"#85B7EB"},{label:"自己啓発",color:"#AFA9EC"}].map(c=>(
                      <div key={c.label} onClick={()=>setSearchQuery(c.label)} style={{background:COLORS.bgCard,borderRadius:14,padding:14,border:`0.5px solid ${COLORS.border}`,cursor:"pointer"}}>
                        <div style={{width:8,height:8,borderRadius:"50%",background:c.color,marginBottom:8}}/>
                        <div style={{fontSize:13,fontWeight:500,color:COLORS.text,marginBottom:3}}>{c.label}</div>
                        <div style={{fontSize:11,color:COLORS.textMuted}}>{allEpisodes.filter(e=>e.category===c.label).length}本</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })()}

        {tab==="record"&&<RecordScreen onPublish={handlePublish}/>}

        {tab==="revenue"&&<div style={{paddingTop:16}}>
          <div style={{fontSize:18,fontWeight:500,color:COLORS.text,marginBottom:4}}>収益</div>
          <div style={{fontSize:12,color:COLORS.textMuted,marginBottom:28}}>あなたの配信が価値に変わる</div>

          {/* メインビジュアル */}
          <div style={{textAlign:"center",padding:"36px 0 32px"}}>
            <div style={{width:80,height:80,borderRadius:"50%",background:COLORS.bgCard,border:`1.5px solid ${COLORS.goldDim}`,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 20px"}}>
              <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
                <circle cx="18" cy="18" r="13" stroke={COLORS.goldDim} strokeWidth="1.5"/>
                <path d="M18 10v16M14 13h5.5a2.5 2.5 0 010 5H14m0 0h7" stroke={COLORS.goldDim} strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </div>
            <div style={{fontSize:17,fontWeight:500,color:COLORS.text,marginBottom:10}}>収益化機能を準備中</div>
            <div style={{fontSize:12,color:COLORS.textMuted,lineHeight:1.8,marginBottom:0}}>
              現在はまだ収益化の機能はありませんが、<br/>
              ORIOが成長していく中で<br/>
              クリエイターが配信で収益を得られる<br/>
              仕組みを整えていきます。
            </div>
          </div>

          {/* 予定している機能リスト */}
          <div style={{background:COLORS.bgCard,borderRadius:16,padding:18,border:`0.5px solid ${COLORS.border}`,marginBottom:10}}>
            <div style={{fontSize:10,color:COLORS.gold,letterSpacing:".08em",marginBottom:14}}>✦ 将来的に提供予定の機能</div>
            {[
              {icon:"📢",label:"広告収益の分配",desc:"再生数に応じた収益を受け取れます"},
              {icon:"👥",label:"リスナーサブスク",desc:"ファンからの月額サポート"},
              {icon:"🎁",label:"投げ銭・ギフト",desc:"リスナーからの直接支援"},
              {icon:"📊",label:"詳細アナリティクス",desc:"再生・フォロワーの詳細データ"},
            ].map((f,i)=>(
              <div key={i} style={{display:"flex",gap:12,alignItems:"flex-start",marginBottom:i<3?14:0}}>
                <div style={{width:34,height:34,borderRadius:10,background:COLORS.bgDeep,border:`0.5px solid ${COLORS.border}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:16}}>{f.icon}</div>
                <div>
                  <div style={{fontSize:12,fontWeight:500,color:COLORS.text,marginBottom:2}}>{f.label}</div>
                  <div style={{fontSize:11,color:COLORS.textMuted}}>{f.desc}</div>
                </div>
              </div>
            ))}
          </div>

          {/* 自分の配信数だけ表示 */}
          <div style={{background:COLORS.bgCard,borderRadius:14,padding:14,border:`0.5px solid ${COLORS.border}`,display:"flex",alignItems:"center",gap:12}}>
            <div style={{width:38,height:38,borderRadius:10,background:COLORS.bgDeep,border:`0.5px solid ${COLORS.goldDim}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><rect x="3" y="3" width="5" height="14" rx="1.5" stroke={COLORS.gold} strokeWidth="1.3"/><rect x="10.5" y="7" width="5" height="10" rx="1.5" stroke={COLORS.gold} strokeWidth="1.3"/></svg>
            </div>
            <div>
              <div style={{fontSize:10,color:COLORS.textMuted,marginBottom:2}}>現在の配信数</div>
              <div style={{fontSize:18,fontWeight:500,color:COLORS.gold}}>{userEpisodes.length}<span style={{fontSize:12,fontWeight:400,marginLeft:3}}>本</span></div>
            </div>
            <div style={{marginLeft:"auto",fontSize:10,color:COLORS.textDim,lineHeight:1.5,textAlign:"right"}}>配信を続けることが<br/>収益化への第一歩です</div>
          </div>
        </div>}

        {tab==="profile"&&<div>

          {/* ── サブページ: プロフィール編集 ── */}
          {profilePage==="edit"&&<div style={{paddingTop:16,animation:"fadeIn .2s ease"}}>
            <button onClick={()=>setProfilePage(null)} style={{display:"flex",alignItems:"center",gap:4,background:"none",border:"none",cursor:"pointer",color:COLORS.textMuted,fontSize:12,marginBottom:20,padding:0}}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              戻る
            </button>
            <div style={{fontSize:16,fontWeight:500,color:COLORS.text,marginBottom:20}}>プロフィール編集</div>
            <div style={{background:COLORS.bgCard,borderRadius:14,padding:16,border:`0.5px solid ${COLORS.border}`,marginBottom:12}}>
              <div style={{fontSize:11,color:COLORS.textMuted,marginBottom:6}}>表示名</div>
              <input
                value={displayName}
                onChange={e=>setDisplayName(e.target.value)}
                placeholder="あなたの名前を入力"
                style={{width:"100%",padding:"10px 12px",borderRadius:10,background:COLORS.bgDeep,border:`0.5px solid ${COLORS.border}`,color:COLORS.text,fontSize:13,outline:"none",marginBottom:16}}
              />
            </div>
            <button onClick={handleSaveDisplayName} disabled={!displayName.trim()} style={{width:"100%",padding:"12px",borderRadius:12,background:COLORS.gold,border:"none",color:COLORS.bg,fontSize:13,fontWeight:600,cursor:"pointer",opacity:displayName.trim()?1:0.5}}>
              保存する
            </button>
          </div>}

          {/* ── サブページ: AIアシスタント設定 ── */}
          {profilePage==="ai"&&<div style={{paddingTop:16,animation:"fadeIn .2s ease"}}>
            <button onClick={()=>setProfilePage(null)} style={{display:"flex",alignItems:"center",gap:4,background:"none",border:"none",cursor:"pointer",color:COLORS.textMuted,fontSize:12,marginBottom:20,padding:0}}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              戻る
            </button>
            <div style={{fontSize:16,fontWeight:500,color:COLORS.text,marginBottom:4}}>AIアシスタント設定</div>
            <div style={{fontSize:12,color:COLORS.textMuted,marginBottom:20}}>録音後のAI自動生成の内容を設定します</div>

            <div style={{background:COLORS.bgCard,borderRadius:14,padding:16,border:`0.5px solid ${COLORS.border}`,marginBottom:10}}>
              <div style={{fontSize:13,color:COLORS.text,marginBottom:3}}>要約ポイント数</div>
              <div style={{fontSize:11,color:COLORS.textMuted,marginBottom:12}}>AI要約で生成される箇条書きの数</div>
              <div style={{display:"flex",gap:8}}>
                {[3,5,7].map(n=>(
                  <button key={n} onClick={()=>setAiSettings(s=>({...s,summaryPoints:n}))} style={{flex:1,padding:"9px 0",borderRadius:10,fontSize:13,fontWeight:500,cursor:"pointer",border:`1px solid ${aiSettings.summaryPoints===n?COLORS.gold:COLORS.border}`,background:aiSettings.summaryPoints===n?COLORS.navy:COLORS.bgDeep,color:aiSettings.summaryPoints===n?COLORS.gold:COLORS.textMuted,transition:"all .15s"}}>{n}項目</button>
                ))}
              </div>
            </div>

            <div style={{background:COLORS.bgCard,borderRadius:14,padding:16,border:`0.5px solid ${COLORS.border}`,marginBottom:10}}>
              <div style={{fontSize:13,color:COLORS.text,marginBottom:3}}>文字起こし言語</div>
              <div style={{fontSize:11,color:COLORS.textMuted,marginBottom:12}}>音声認識に使う言語</div>
              <div style={{display:"flex",gap:8}}>
                {[{val:"ja-JP",label:"日本語"},{val:"en-US",label:"English"}].map(l=>(
                  <button key={l.val} onClick={()=>setAiSettings(s=>({...s,transcriptLang:l.val}))} style={{flex:1,padding:"9px 0",borderRadius:10,fontSize:13,fontWeight:500,cursor:"pointer",border:`1px solid ${aiSettings.transcriptLang===l.val?COLORS.gold:COLORS.border}`,background:aiSettings.transcriptLang===l.val?COLORS.navy:COLORS.bgDeep,color:aiSettings.transcriptLang===l.val?COLORS.gold:COLORS.textMuted,transition:"all .15s"}}>{l.label}</button>
                ))}
              </div>
            </div>

            <div style={{background:COLORS.bgCard,borderRadius:14,padding:16,border:`0.5px solid ${COLORS.border}`,marginBottom:16}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div style={{flex:1,marginRight:12}}>
                  <div style={{fontSize:13,color:COLORS.text,marginBottom:3}}>カテゴリ自動判定</div>
                  <div style={{fontSize:11,color:COLORS.textMuted}}>AIが内容からカテゴリを自動で判定します</div>
                </div>
                <div onClick={()=>setAiSettings(s=>({...s,autoCategory:!s.autoCategory}))} style={{width:44,height:24,borderRadius:12,background:aiSettings.autoCategory?COLORS.gold:COLORS.border,position:"relative",cursor:"pointer",transition:"background .2s",flexShrink:0}}>
                  <div style={{position:"absolute",top:2,left:aiSettings.autoCategory?22:2,width:20,height:20,borderRadius:"50%",background:"white",transition:"left .2s",boxShadow:"0 1px 3px rgba(0,0,0,.3)"}}/>
                </div>
              </div>
            </div>

            <div style={{background:COLORS.bgCard,borderRadius:14,padding:14,border:`0.5px solid ${COLORS.goldDim}`}}>
              <div style={{fontSize:10,color:COLORS.gold,marginBottom:6}}>✦ 設定について</div>
              <div style={{fontSize:11,color:COLORS.textMuted,lineHeight:1.6}}>設定変更は次回の録音から反映されます。変更は自動的に保存されます。</div>
            </div>
          </div>}

          {/* ── サブページ: 収益設定・振込先 ── */}
          {profilePage==="revenue"&&<div style={{paddingTop:16,animation:"fadeIn .2s ease"}}>
            <button onClick={()=>setProfilePage(null)} style={{display:"flex",alignItems:"center",gap:4,background:"none",border:"none",cursor:"pointer",color:COLORS.textMuted,fontSize:12,marginBottom:20,padding:0}}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              戻る
            </button>
            <div style={{fontSize:16,fontWeight:500,color:COLORS.text,marginBottom:4}}>収益設定・振込先</div>
            <div style={{fontSize:12,color:COLORS.textMuted,marginBottom:24}}>収益の受け取り設定を管理します</div>

            {/* メッセージ */}
            <div style={{background:COLORS.bgCard,borderRadius:16,padding:20,border:`0.5px solid ${COLORS.border}`,marginBottom:10,textAlign:"center"}}>
              <div style={{width:56,height:56,borderRadius:"50%",background:COLORS.bgDeep,border:`1px solid ${COLORS.goldDim}`,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 16px"}}>
                <svg width="26" height="26" viewBox="0 0 28 28" fill="none">
                  <circle cx="14" cy="14" r="10" stroke={COLORS.goldDim} strokeWidth="1.4"/>
                  <path d="M14 8v10M11 10.5h4.5a2 2 0 010 4H11m0 0h5" stroke={COLORS.goldDim} strokeWidth="1.4" strokeLinecap="round"/>
                </svg>
              </div>
              <div style={{fontSize:14,fontWeight:500,color:COLORS.text,marginBottom:10}}>収益化機能を準備中です</div>
              <div style={{fontSize:11,color:COLORS.textMuted,lineHeight:1.8}}>
                振込先の登録や収益の受け取りは、<br/>
                現時点ではまだご利用いただけません。<br/>
                今は配信を積み重ねる時期です。
              </div>
            </div>

            {/* 将来の予定 */}
            <div style={{background:COLORS.bgCard,borderRadius:16,padding:16,border:`0.5px solid ${COLORS.border}`,marginBottom:10}}>
              <div style={{fontSize:10,color:COLORS.gold,letterSpacing:".08em",marginBottom:12}}>✦ 将来的に登録できるようになる情報</div>
              {[
                {icon:"🏦",label:"銀行口座",desc:"収益の振込先口座"},
                {icon:"🪪",label:"本人確認書類",desc:"収益受け取りに必要な確認"},
                {icon:"📄",label:"振込スケジュール",desc:"月次・週次など支払いサイクルの設定"},
              ].map((f,i)=>(
                <div key={i} style={{display:"flex",gap:12,alignItems:"center",marginBottom:i<2?12:0,opacity:0.45}}>
                  <div style={{width:32,height:32,borderRadius:8,background:COLORS.bgDeep,border:`0.5px solid ${COLORS.border}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:15}}>{f.icon}</div>
                  <div>
                    <div style={{fontSize:12,color:COLORS.text,marginBottom:1}}>{f.label}</div>
                    <div style={{fontSize:10,color:COLORS.textMuted}}>{f.desc}</div>
                  </div>
                  <div style={{marginLeft:"auto",fontSize:10,color:COLORS.textDim,whiteSpace:"nowrap"}}>準備中</div>
                </div>
              ))}
            </div>

            {/* 今できること */}
            <div style={{background:COLORS.bgCard,borderRadius:14,padding:14,border:`0.5px solid ${COLORS.goldDim}`}}>
              <div style={{fontSize:10,color:COLORS.gold,marginBottom:8}}>✦ 今あなたにできること</div>
              <div style={{fontSize:11,color:COLORS.textMuted,lineHeight:1.8}}>質の高い配信を続けてリスナーを増やしましょう。収益化の機能が整った際に、すぐに活用できる状態を作っておくことが大切です。</div>
            </div>
          </div>}

          {/* ── サブページ: プライバシー設定 ── */}
          {profilePage==="privacy"&&<div style={{paddingTop:16,animation:"fadeIn .2s ease"}}>
            <button onClick={()=>setProfilePage(null)} style={{display:"flex",alignItems:"center",gap:4,background:"none",border:"none",cursor:"pointer",color:COLORS.textMuted,fontSize:12,marginBottom:20,padding:0}}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              戻る
            </button>
            <div style={{fontSize:16,fontWeight:500,color:COLORS.text,marginBottom:4}}>プライバシー設定</div>
            <div style={{fontSize:12,color:COLORS.textMuted,marginBottom:20}}>配信のプライバシーを管理します</div>

            {[
              {key:"publicProfile", label:"プロフィールを公開する",  desc:"他のユーザーにプロフィールを表示します"},
              {key:"showPlays",     label:"再生数を表示する",         desc:"各配信の再生数を公開します"},
              {key:"showActivity",  label:"活動状況を表示する",       desc:"最終アクティブ時間を他のユーザーに表示します"},
            ].map(item=>{
              const isOn=privacySettings[item.key];
              return(
                <div key={item.key} style={{background:COLORS.bgCard,borderRadius:14,padding:16,border:`0.5px solid ${isOn?COLORS.goldDim:COLORS.border}`,marginBottom:8,transition:"border-color .15s"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div style={{flex:1,marginRight:12}}>
                      <div style={{fontSize:13,color:COLORS.text,marginBottom:3}}>{item.label}</div>
                      <div style={{fontSize:11,color:COLORS.textMuted}}>{item.desc}</div>
                    </div>
                    {/* トグルスイッチ */}
                    <div
                      onClick={()=>setPrivacySettings(s=>({...s,[item.key]:!s[item.key]}))}
                      style={{width:44,height:24,borderRadius:12,background:isOn?COLORS.gold:COLORS.border,position:"relative",cursor:"pointer",transition:"background .2s",flexShrink:0}}
                    >
                      <div style={{position:"absolute",top:2,left:isOn?22:2,width:20,height:20,borderRadius:"50%",background:"white",transition:"left .2s",boxShadow:"0 1px 3px rgba(0,0,0,.3)"}}/>
                    </div>
                  </div>
                </div>
              );
            })}

            <div style={{background:COLORS.bgCard,borderRadius:14,padding:14,border:`0.5px solid ${COLORS.goldDim}`,marginTop:4}}>
              <div style={{fontSize:10,color:COLORS.gold,marginBottom:6}}>✦ 設定について</div>
              <div style={{fontSize:11,color:COLORS.textMuted,lineHeight:1.6}}>変更はすぐに反映されます。設定は自動的に保存されます。</div>
            </div>
          </div>}

          {/* ── メインプロフィールページ ── */}
          {!profilePage&&<div>
            {/* ヘッダーバナー（アバターをoverflow:hiddenの外に出す） */}
            <div style={{position:"relative",marginBottom:52}}>
              {/* バナー画像（overflow:hiddenで角丸） */}
              <div style={{borderRadius:16,overflow:"hidden",height:116}}>
                {headerUrl
                  ?<img src={headerUrl} alt="" style={{width:"100%",height:116,objectFit:"cover",display:"block"}}/>
                  :<div style={{width:"100%",height:116,background:`linear-gradient(135deg, ${COLORS.navy} 0%, ${COLORS.bgDeep} 100%)`}}/>
                }
                {/* ヘッダー編集ボタン */}
                <label style={{position:"absolute",bottom:8,right:8,display:"flex",alignItems:"center",gap:4,background:"rgba(5,11,21,.72)",borderRadius:8,padding:"5px 10px",cursor:"pointer",backdropFilter:"blur(4px)"}}>
                  <input type="file" accept="image/*" onChange={handleHeaderChange} style={{display:"none"}}/>
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M8.5 1.5l2 2L3 11H1v-2L8.5 1.5z" stroke={COLORS.textMuted} strokeWidth="1.3" strokeLinejoin="round"/></svg>
                  <span style={{fontSize:10,color:COLORS.textMuted}}>ヘッダー編集</span>
                </label>
              </div>
              {/* アバター（バナーの外側に配置→クリップされない） */}
              <div style={{position:"absolute",bottom:-32,left:14}}>
                <div style={{position:"relative",display:"inline-flex"}}>
                  {/* アバター本体 */}
                  <div style={{padding:3,borderRadius:"50%",background:COLORS.bgDeep,display:"inline-flex"}}>
                    {avatarUrl
                      ?<div style={{width:62,height:62,borderRadius:"50%",border:`2px solid ${COLORS.gold}`,overflow:"hidden",display:"flex",alignItems:"center",justifyContent:"center"}}>
                          <img src={avatarUrl} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                        </div>
                      :<div style={{width:62,height:62,borderRadius:"50%",background:COLORS.navy,border:`2px solid ${COLORS.gold}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,fontWeight:500,color:COLORS.gold}}>{userInitial}</div>
                    }
                  </div>
                  {/* アイコン変更ボタン（カメラアイコン） */}
                  <label style={{position:"absolute",bottom:4,right:4,width:22,height:22,borderRadius:"50%",background:COLORS.gold,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",border:`2px solid ${COLORS.bgDeep}`,flexShrink:0}}>
                    <input type="file" accept="image/*" onChange={handleAvatarChange} style={{display:"none"}}/>
                    <svg width="11" height="11" viewBox="0 0 14 14" fill="none">
                      <path d="M5.5 2h3l1.2 1.5H12a1 1 0 011 1v6a1 1 0 01-1 1H2a1 1 0 01-1-1V4.5a1 1 0 011-1h2.3L5.5 2z" stroke={COLORS.bg} strokeWidth="1.1" strokeLinejoin="round"/>
                      <circle cx="7" cy="7.5" r="1.8" stroke={COLORS.bg} strokeWidth="1.1"/>
                    </svg>
                  </label>
                </div>
              </div>
            </div>

            {/* 名前 + 編集アイコン */}
            <div style={{marginBottom:16}}>
              <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:2}}>
                <div style={{fontSize:16,fontWeight:500,color:COLORS.text}}>{displayName||"名前未設定"}</div>
                <button onClick={()=>setProfilePage("edit")} title="名前を編集" style={{background:"none",border:"none",cursor:"pointer",padding:2,color:COLORS.textDim,display:"flex",alignItems:"center",lineHeight:1}}>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M8.5 1.5l2 2L3 11H1v-2L8.5 1.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>
                </button>
              </div>
            </div>

            {/* 統計 */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:16}}>
              {[{label:"配信数",val:`${userEpisodes.length}`},{label:"リスナー",val:"1.1k"},{label:"総再生",val:"18k"}].map(s=>(
                <div key={s.label} style={{background:COLORS.bgCard,borderRadius:12,padding:10,textAlign:"center",border:`0.5px solid ${COLORS.border}`}}>
                  <div style={{fontSize:16,fontWeight:500,color:COLORS.gold}}>{s.val}</div>
                  <div style={{fontSize:10,color:COLORS.textMuted}}>{s.label}</div>
                </div>
              ))}
            </div>

            {/* 設定リスト */}
            {[
              {label:"収益設定・振込先",icon:"💰",page:"revenue"},
              {label:"プロフィール編集",icon:"✏️",page:"edit"},
              {label:"AIアシスタント設定",icon:"✦",page:"ai"},
              {label:"プライバシー設定",icon:"🔒",page:"privacy"},
            ].map(item=>(
              <div key={item.label} onClick={()=>setProfilePage(item.page)} style={{display:"flex",alignItems:"center",gap:12,padding:"13px 14px",background:COLORS.bgCard,borderRadius:12,marginBottom:8,border:`0.5px solid ${COLORS.border}`,cursor:"pointer"}}>
                <span style={{fontSize:15,lineHeight:1,width:20,textAlign:"center",flexShrink:0}}>{item.icon}</span>
                <span style={{fontSize:13,color:COLORS.text}}>{item.label}</span>
                <span style={{marginLeft:"auto",color:COLORS.textDim,fontSize:16}}>›</span>
              </div>
            ))}
            <button onClick={handleSignOut} style={{width:"100%",padding:"10px",borderRadius:12,background:"none",border:`0.5px solid ${COLORS.red}`,color:COLORS.red,fontSize:12,cursor:"pointer",marginTop:8}}>
              ログアウト
            </button>
          </div>}

        </div>}
        <div style={{height:16}}/>
      </div>

      <PlayerBar ep={playingEp} playing={isPlaying} onToggle={()=>setIsPlaying(p=>!p)}/>

      <div style={{background:COLORS.bgDeep,borderTop:`0.5px solid ${COLORS.border}`,padding:"10px 0 18px",display:"flex",justifyContent:"space-around"}}>
        {navItems.map(n=><button key={n.id} onClick={()=>{setTab(n.id);setChannelCreator(null);setProfilePage(null);}} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:3,background:"none",border:"none",cursor:"pointer",padding:"0 8px",color:tab===n.id&&tab!=="channel"?COLORS.gold:tab==="channel"&&n.id==="home"?COLORS.gold:COLORS.textDim}}>
          {n.icon}
          <span style={{fontSize:9}}>{n.label}</span>
        </button>)}
      </div>
    </div>
  </div>;
}
