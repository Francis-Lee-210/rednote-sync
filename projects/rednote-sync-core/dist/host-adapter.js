import { SafeError } from "./errors.js";
                                                          

function safeId(value         , label        )         {
  if (typeof value !== "string") throw new SafeError("INVALID_INPUT", `${label} must be text`);
  const normalized = value.normalize("NFC").trim();
  if (normalized.length < 1 || normalized.length > 200 || /[\u0000-\u001f\u007f/\\]/u.test(normalized) || normalized === "." || normalized === "..") throw new SafeError("INVALID_INPUT", `invalid ${label}`);
  return normalized;
}

function decodeAdapterHost(value         )         {
  if (value !== "xhs" && value !== "rednote") throw new SafeError("INVALID_INPUT", "invalid host");
  return value;
}

function decodeAdapterNote(value         )         { return safeId(value, "note id")          ; }
function decodeAdapterBoard(value         )          { return safeId(value, "board id")           ; }

                              
                          
                             
                                                                     
                          
                                      
                                        
                                        
                                                             
                                                                
                                                                  
                                                           
 

function parseExactHttps(value         , origin        )      {
  if (typeof value !== "string") throw new SafeError("INVALID_INPUT", "public URL must be text");
  let parsed     ;
  try { parsed = new URL(value); } catch { throw new SafeError("INVALID_INPUT", "invalid public URL"); }
  if (parsed.protocol !== "https:" || parsed.origin !== origin || parsed.port !== "" || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
    throw new SafeError("INVALID_INPUT", "public URL origin or components are invalid");
  }
  return parsed;
}

function createHostAdapter(hostIdInput        , webOrigin        )              {
  const hostId = decodeAdapterHost(hostIdInput);
  const publicNoteUrl = (noteIdInput        )         => {
    const noteId = decodeAdapterNote(noteIdInput);
    return `${webOrigin}/explore/${encodeURIComponent(noteId)}`;
  };
  const sanitizeImportedUrl = (value        , noteIdInput        )         => {
    const canonical = publicNoteUrl(noteIdInput);
    const parsed = parseExactHttps(value, webOrigin);
    if (parsed.pathname !== new URL(canonical).pathname) throw new SafeError("INVALID_INPUT", "public note URL does not match note id");
    return canonical;
  };
  const normalizeAuthorPublicUrl = (value               )                => {
    if (value === null) return null;
    const parsed = parseExactHttps(value, webOrigin);
    return `${webOrigin}${parsed.pathname}`;
  };
  return Object.freeze({
    hostId,
    webOrigin,
    origin: webOrigin,
    parseNoteId: decodeAdapterNote,
    parseBoardId: decodeAdapterBoard,
    publicNoteUrl,
    sanitizeImportedUrl,
    normalizeAuthorPublicUrl,
    sanitizeImportedNoteUrl(value         , noteIdInput        )         {
      if (typeof value !== "string") throw new SafeError("INVALID_INPUT", "public URL must be text");
      return sanitizeImportedUrl(value, noteIdInput);
    },
    sanitizeImportedAuthorUrl(value         )                {
      if (value !== null && typeof value !== "string") throw new SafeError("INVALID_INPUT", "public URL must be text");
      return normalizeAuthorPublicUrl(value);
    },
  });
}

const HOST_ADAPTERS                                        = Object.freeze({
  xhs: createHostAdapter("xhs", "https://www.xiaohongshu.com"),
  rednote: createHostAdapter("rednote", "https://www.rednote.com"),
});

/** Origins are based only on reviewed static samples; online validity remains a Stage-4 verification item. */
export function getHostAdapter(hostIdInput        )              {
  return HOST_ADAPTERS[decodeAdapterHost(hostIdInput)];
}
