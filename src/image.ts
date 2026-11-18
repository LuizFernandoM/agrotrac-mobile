// Bounded structural validation before native Image.getSize. Full decoder remains
// the native image implementation and Audit/libvips; this is not a JS image codec.
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const invalid = (): never => { throw Error('Imagem JPEG/PNG inválida ou truncada.'); };
  if ([137,80,78,71,13,10,26,10].every((n,i)=>bytes[i]===n)) {
    let at=8, width=0,height=0,data=false,chunks=0;
    while(at+12<=bytes.length){
      const size=view.getUint32(at),end=at+12+size;
      if(end>bytes.length)invalid();
      const type=String.fromCharCode(...bytes.subarray(at+4,at+8));
      if(!chunks && (type!=='IHDR'||size!==13))invalid();
      let crc=0xffffffff;
      for(const b of bytes.subarray(at+4,end-4)){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
      if(((crc^0xffffffff)>>>0)!==view.getUint32(end-4))invalid();
      if(type==='IHDR'){if(chunks)invalid();width=view.getUint32(at+8);height=view.getUint32(at+12);}
      if(['acTL','fcTL','fdAT'].includes(type))invalid();
      if(type==='IDAT')data=true;
      if(type==='IEND'){if(size||!data||end!==bytes.length)invalid();return {width,height};}
      chunks++;at=end;
    }
    return invalid();
  }
  if(bytes[0]!==255||bytes[1]!==216)return invalid();
  let at=2,width=0,height=0,sos=false;
  while(at<bytes.length){
    if(bytes[at++]!==255)return invalid();
    while(bytes[at]===255)at++;
    const marker=bytes[at++];
    if(marker===217){if(!sos||!width||!height||at!==bytes.length)invalid();return {width,height};}
    if(marker===undefined||marker===0||marker===216||marker>=208&&marker<=215)invalid();
    if(marker===1)continue;
    if(at+2>bytes.length)invalid();
    const size=view.getUint16(at);if(size<2||at+size>bytes.length)invalid();
    if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){
      if(size<8)invalid();height=view.getUint16(at+3);width=view.getUint16(at+5);
    }
    at+=size;
    if(marker===218){
      sos=true;
      while(at<bytes.length){
        if(bytes[at]!==255){at++;continue;}
        let next=at+1;while(bytes[next]===255)next++;
        if(bytes[next]===0||bytes[next]>=208&&bytes[next]<=215){at=next+1;continue;}
        break;
      }
    }
  }
  return invalid();
}
