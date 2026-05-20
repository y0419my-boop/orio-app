import { useState, useEffect, useRef, useCallback } from "react";
export default function ORIOApp() {
  const [tab, setTab] = useState("home");
  return (
    <div style={{background:"#070D1A",minHeight:"100vh",display:"flex",justifyContent:"center",alignItems:"flex-start",padding:"24px 16px",fontFamily:"'Helvetica Neue',Arial,sans-serif",color:"#E8EEF8"}}>
      <div style={{width:"100%",maxWidth:390,background:"#050B15",borderRadius:40,overflow:"hidden",border:"1.5px solid #1A2D4A",minHeight:720,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:32}}>
        <div style={{fontSize:32,fontWeight:500,letterSpacing:8,color:"#E8EEF8",marginBottom:8}}>ORIO</div>
        <div style={{fontSize:14,color:"#C9A84C",marginBottom:32}}>あなたの本音を、耳へ届ける</div>
        <div style={{fontSize:13,color:"#607090"}}>デプロイ成功！🎉</div>
      </div>
    </div>
  );
}
