import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Archive,
  Bell,
  Camera,
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  Copy,
  Download,
  Eye,
  GripVertical,
  Images,
  KeyRound,
  ListChecks,
  LogOut,
  Moon,
  PackageCheck,
  Plus,
  QrCode,
  RefreshCw,
  ScanLine,
  Search,
  ShieldCheck,
  Sun,
  Trash2,
  UserPlus,
  UserCircle,
  XCircle
} from "lucide-react";
import { api } from "./api.js";

const STAFF_SESSION_KEY = "power-tool-staff-session";
const VISIT_SESSION_KEY = "power-tool-visit-session";
const RECENT_REQUESTS_KEY = "power-tool-recent-requests";
const VISIT_HEARTBEAT_MS = 60_000;
const DEVELOPER_CREDIT = "Made by Riemar R. Seruelas Jr - Data Digital Intern";
const QUESTION_TYPES = [
  { value: "text", label: "Short answer" },
  { value: "textarea", label: "Paragraph" },
  { value: "radio", label: "Multiple choice" },
  { value: "checkboxes", label: "Checkboxes" },
  { value: "select", label: "Dropdown" },
  { value: "yesno", label: "Yes / No" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "image", label: "Image" }
];
const OPTION_QUESTION_TYPES = new Set(["radio", "checkboxes", "select"]);
const AUTO_DECISION_QUESTION_TYPES = new Set(["radio", "select", "yesno"]);
const SITE_OPTIONS = ["Savoury", "Engineering", "Dressings"];
const PRINT_QR_DPI = 300;
const PRINT_QR_CM = 2;
const PRINT_QR_PIXELS = Math.round((PRINT_QR_CM / 2.54) * PRINT_QR_DPI);

console.info(`%c${DEVELOPER_CREDIT}`, "color:#0f62fe;font-weight:800;");

function canStaffActOnRequest(session, request) {
  return ["reviewer", "admin"].includes(session?.role) && request.status === "pending";
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "2-digit" });
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-PH", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function cx(...classes) {
  return classes.filter(Boolean).join(" ");
}

function getVisitSessionId() {
  let sessionId = sessionStorage.getItem(VISIT_SESSION_KEY);
  if (!sessionId) {
    sessionId = globalThis.crypto?.randomUUID?.() || `visit-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem(VISIT_SESSION_KEY, sessionId);
  }
  return sessionId;
}

function readRecentRequests() {
  try {
    const stored = JSON.parse(localStorage.getItem(RECENT_REQUESTS_KEY) || "[]");
    return Array.isArray(stored) ? stored.filter((entry) => entry?.referenceId).slice(0, 20) : [];
  } catch {
    return [];
  }
}

function saveRecentRequest(request) {
  const current = readRecentRequests().filter((entry) => entry.referenceId !== request.referenceId);
  localStorage.setItem(RECENT_REQUESTS_KEY, JSON.stringify([request, ...current].slice(0, 20)));
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

function questionAnswerOptions(field) {
  if (field?.type === "yesno") return ["Yes", "No"];
  if (["radio", "select"].includes(field?.type)) return field.options || [];
  return [];
}

function normalizedAutoOutcomes(field, enabled = field?.autoDecision?.enabled) {
  if (!enabled || !AUTO_DECISION_QUESTION_TYPES.has(field?.type)) return {};
  const previous = field.autoDecision?.outcomes || {};
  const options = questionAnswerOptions(field);
  if (field.type === "yesno" && Object.keys(previous).length === 0) {
    return { Yes: "approved", No: "rejected" };
  }
  return Object.fromEntries(options.map((option) => [option, previous[option] || ""]));
}

function parseQrText(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";

  try {
    const url = new URL(raw);
    const parts = url.pathname.split("/").filter(Boolean);
    const itemIndex = parts.findIndex((part) => part.toLowerCase() === "item");
    if (itemIndex !== -1 && parts[itemIndex + 1]) return decodeURIComponent(parts[itemIndex + 1]);
  } catch {
    // Normal QR-ID text is still valid.
  }

  if (raw.startsWith("POWERTOOL:")) return raw.replace("POWERTOOL:", "").trim();
  if (raw.startsWith("MACHINEQR:")) return raw.replace("MACHINEQR:", "").trim();
  if (raw.startsWith("QR-")) return raw;
  return raw;
}

function StatCard({ icon: Icon, label, value, tone = "default", active = false, onClick, badge = 0 }) {
  const finalBadge = Number(badge || 0);
  const cardContent = (
    <>
      <div className="stat-icon"><Icon size={15} /></div>
      <div className="stat-text">
        <p>{label}</p>
        <strong>{value}</strong>
      </div>
      {finalBadge > 0 && <span className="notif-badge">{finalBadge > 99 ? "99+" : finalBadge}</span>}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={cx("stat-card", "clickable", `tone-${tone}`, active && "active")}
        onClick={onClick}
        aria-label={`${label}: ${value}`}
        title={label}
      >
        {cardContent}
      </button>
    );
  }

  return <section className={cx("stat-card", `tone-${tone}`)}>{cardContent}</section>;
}

function StatusBadge({ validity, status }) {
  const finalStatus = status || validity?.status || "unknown";
  const labels = {
    valid: "Good",
    expired: "Expired",
    archived: "Archived",
    approved: "Accepted",
    accepted: "Accepted",
    rejected: "Rejected",
    pending: "Pending"
  };
  return <span className={cx("status-badge", finalStatus)}>{labels[finalStatus] || finalStatus}</span>;
}

function qrDownloadName({ itemCode, itemName, qrId, referenceId } = {}) {
  const safeName = String(itemCode || itemName || referenceId || qrId || "qr-code")
    .trim()
    .replace(/[^a-z0-9-_]+/gi, "-")
    .replace(/(^-|-$)/g, "") || "qr-code";
  return `${safeName}-qr-2cm.jpg`;
}

function patchJpegDpi(bytes, dpi) {
  for (let index = 0; index < Math.min(bytes.length - 18, 64); index += 1) {
    const isJfif = bytes[index] === 0xff
      && bytes[index + 1] === 0xe0
      && String.fromCharCode(...bytes.slice(index + 4, index + 9)) === "JFIF\u0000";
    if (!isJfif) continue;
    bytes[index + 11] = 1;
    bytes[index + 12] = (dpi >> 8) & 0xff;
    bytes[index + 13] = dpi & 0xff;
    bytes[index + 14] = (dpi >> 8) & 0xff;
    bytes[index + 15] = dpi & 0xff;
    break;
  }
  return bytes;
}

async function createPrintableQrJpeg(qrImageDataUrl) {
  const image = await new Promise((resolve, reject) => {
    const next = new Image();
    next.onload = () => resolve(next);
    next.onerror = reject;
    next.src = qrImageDataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = PRINT_QR_PIXELS;
  canvas.height = PRINT_QR_PIXELS;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser could not prepare the printable QR.");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = false;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 1));
  if (!blob) throw new Error("This browser could not prepare the printable QR.");
  const bytes = patchJpegDpi(new Uint8Array(await blob.arrayBuffer()), PRINT_QR_DPI);
  return new Blob([bytes], { type: "image/jpeg" });
}

function DownloadQrLink({ qrImageDataUrl, itemCode, itemName, qrId, referenceId, className = "ghost-btn tiny" }) {
  const [busy, setBusy] = useState(false);
  if (!qrImageDataUrl) return null;

  async function download() {
    setBusy(true);
    try {
      const blob = await createPrintableQrJpeg(qrImageDataUrl);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = qrDownloadName({ itemCode, itemName, qrId, referenceId });
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      alert(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" className={className} onClick={download} disabled={busy} title="2 × 2 cm JPG at 300 DPI">
      <Download size={14} /> {busy ? "Preparing..." : "Download QR"}
    </button>
  );
}

async function imageFileToDataUrl(file) {
  const raw = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  const image = await new Promise((resolve, reject) => {
    const next = new Image();
    next.onload = () => resolve(next);
    next.onerror = reject;
    next.src = raw;
  });

  const maxDimension = 1600;
  const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) return raw;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.82);
}

function recordImages(record) {
  const images = Array.isArray(record?.toolImages)
    ? record.toolImages
    : (record?.toolImage ? [record.toolImage] : []);
  return images.filter(Boolean);
}

function MultiImageInput({ images = [], onChange }) {
  const [busy, setBusy] = useState(false);

  async function addImages(event) {
    const files = [...(event.target.files || [])];
    event.target.value = "";
    if (!files.length) return;
    if (images.length + files.length > 8) {
      alert("You can upload up to 8 equipment images.");
      return;
    }
    if (files.some((file) => !file.type.startsWith("image/"))) {
      alert("Please select image files only.");
      return;
    }

    setBusy(true);
    try {
      const uploaded = [];
      for (const file of files) uploaded.push(await imageFileToDataUrl(file));
      onChange([...images, ...uploaded]);
    } catch {
      alert("One of the selected images could not be read.");
    } finally {
      setBusy(false);
    }
  }

  function removeImage(index) {
    onChange(images.filter((_, imageIndex) => imageIndex !== index));
  }

  return (
    <div className="multi-image-input">
      <div className="image-upload-row">
        <label className="secondary-btn small image-upload-button">
          <Images size={15} /> {busy ? "Adding..." : images.length ? "Add more images" : "Add images"}
          <input type="file" accept="image/*" capture="environment" multiple disabled={busy} onChange={addImages} />
        </label>
        <span>{images.length}/8 image(s)</span>
      </div>
      {images.length > 0 && (
        <div className="image-upload-grid">
          {images.map((image, index) => (
            <div key={`${image.slice(-24)}-${index}`} className="image-upload-preview">
              <img src={image} alt={`Equipment ${index + 1}`} />
              <button type="button" onClick={() => removeImage(index)}>Remove</button>
              {index === 0 && <small>Primary</small>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ToolImageGallery({ record }) {
  const images = recordImages(record);
  const [activeIndex, setActiveIndex] = useState(0);
  const [showMore, setShowMore] = useState(false);

  useEffect(() => {
    setActiveIndex(0);
    setShowMore(false);
  }, [record?.id]);

  if (!images.length) return null;

  return (
    <div className="details-list tool-photo-panel">
      <div className="tool-photo-heading">
        <h3>Tool image</h3>
        {images.length > 1 && (
          <button type="button" className="secondary-btn tiny" onClick={() => setShowMore((current) => !current)}>
            <Images size={14} /> {showMore ? "Hide images" : `More images (${images.length - 1})`}
          </button>
        )}
      </div>
      <img src={images[activeIndex]} alt={`${record.itemName} image ${activeIndex + 1}`} className="tool-photo" />
      {showMore && (
        <div className="tool-photo-thumbnails">
          {images.map((image, index) => (
            <button type="button" key={`${image.slice(-24)}-${index}`} className={cx(index === activeIndex && "active")} onClick={() => setActiveIndex(index)}>
              <img src={image} alt={`Show equipment image ${index + 1}`} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function FieldInput({ field, value, onChange, hidePlaceholder = false }) {
  if (field.type === "image") {
    async function handleFile(event) {
      const file = event.target.files?.[0];
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        alert("Please select an image file.");
        event.target.value = "";
        return;
      }
      try {
        onChange(field.id, await imageFileToDataUrl(file));
      } catch {
        alert("The selected image could not be read.");
      }
    }

    return (
      <div className="image-input-box">
        {value ? <img src={value} alt={field.label} className="image-preview" /> : <div className="image-placeholder">No image</div>}
        <div className="image-input-actions">
          <input id={field.id} type="file" accept="image/*" capture="environment" required={field.required && !value} onChange={handleFile} />
          {value && <button type="button" className="ghost-btn tiny" onClick={() => onChange(field.id, "")}>Remove</button>}
        </div>
      </div>
    );
  }

  const commonProps = {
    id: field.id,
    value: value ?? "",
    required: field.required,
    placeholder: hidePlaceholder ? undefined : (field.placeholder || field.label),
    onChange: (event) => onChange(field.id, event.target.value)
  };

  if (field.type === "textarea") return <textarea {...commonProps} rows={2} />;

  if (field.type === "select") {
    return (
      <select {...commonProps}>
        <option value="">{hidePlaceholder ? "" : `Select ${field.label}`}</option>
        {(field.options || []).map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    );
  }

  if (field.type === "radio" || field.type === "yesno") {
    const options = field.type === "yesno" ? ["Yes", "No"] : (field.options || []);
    return (
      <div className="answer-options" role="radiogroup" aria-label={field.label}>
        {options.map((option) => (
          <label key={option} className="answer-option">
            <input
              type="radio"
              name={field.id}
              value={option}
              checked={value === option}
              required={field.required}
              onChange={(event) => onChange(field.id, event.target.value)}
            />
            <span>{option}</span>
          </label>
        ))}
      </div>
    );
  }

  if (field.type === "checkboxes") {
    const selected = Array.isArray(value) ? value : [];
    return (
      <div className="answer-options" aria-label={field.label}>
        {(field.options || []).map((option) => (
          <label key={option} className="answer-option">
            <input
              type="checkbox"
              value={option}
              checked={selected.includes(option)}
              onChange={(event) => {
                const next = event.target.checked
                  ? [...selected, option]
                  : selected.filter((entry) => entry !== option);
                onChange(field.id, next);
              }}
            />
            <span>{option}</span>
          </label>
        ))}
      </div>
    );
  }

  return <input {...commonProps} type={field.type || "text"} />;
}

function FieldRows({ fields = [], values = {}, compact = false }) {
  const knownRows = (fields || []).map((field) => ({
    id: field.id,
    label: field.label,
    type: field.type,
    value: values?.[field.id]
  }));
  const knownIds = new Set(knownRows.map((row) => row.id));
  const extraRows = Object.entries(values || {})
    .filter(([key]) => !knownIds.has(key))
    .map(([key, value]) => ({ id: key, label: key.replace(/^field-/, "").replaceAll("-", " "), value }));

  const rows = [...knownRows, ...extraRows];
  if (rows.length === 0) return <p className="muted">No extra details submitted.</p>;

  return (
    <div className={compact ? "detail-lines compact" : "details-lines-full"}>
      {rows.map((row) => {
        const isImage = row.type === "image" && row.value;
        return (
          <div key={row.id} className={cx(compact ? undefined : "detail-line", isImage && "image-line")}>
            <span>{row.label}</span>
            {isImage ? (
              <img src={row.value} alt={row.label} className="stored-image" />
            ) : (
              <strong>{row.type === "date" ? formatDate(row.value) : (Array.isArray(row.value) ? (row.value.join(", ") || "—") : (row.value || "—"))}</strong>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ReviewAnswerSummary({ questions = [], answers = {} }) {
  if (!questions.length) return <p className="muted">No review questions were configured for this tool type.</p>;
  return (
    <div className="review-answer-summary">
      {questions.map((question, index) => {
        const rawAnswer = answers?.[question.id];
        const answer = Array.isArray(rawAnswer) ? rawAnswer.join(", ") : rawAnswer;
        return (
          <div key={question.id || index} className="review-answer-chip">
            <strong>{question.label}</strong>
            <span>{answer || "—"}</span>
          </div>
        );
      })}
    </div>
  );
}

function ReviewerFeedback({ note, reviewedBy, reviewedAt, label = "Reviewer feedback" }) {
  return (
    <div className="review-feedback">
      <div>
        <strong>{label}</strong>
        <span>{note || "No feedback was added."}</span>
      </div>
      {(reviewedBy || reviewedAt) && (
        <small>
          {reviewedBy ? `By ${reviewedBy}` : ""}
          {reviewedBy && reviewedAt ? " • " : ""}
          {reviewedAt ? formatDateTime(reviewedAt) : ""}
        </small>
      )}
    </div>
  );
}

function EmptyState({ icon: Icon = ClipboardList, title, message }) {
  return (
    <div className="empty-state">
      <Icon size={30} />
      <h3>{title}</h3>
      <p>{message}</p>
    </div>
  );
}

function UserHome({ onPick }) {
  return (
    <main className="choice-page">
      <div className="choice-grid">
        <button className="choice-card" onClick={() => onPick("register")}>
          <PackageCheck size={26} />
          <strong>Register tool</strong>
          <span>Add an ELC or Portable Tools item.</span>
        </button>
        <button className="choice-card" onClick={() => onPick("followup")}>
          <ScanLine size={26} />
          <strong>Follow up</strong>
          <span>Scan QR or check reference.</span>
        </button>
      </div>
    </main>
  );
}

function UserRegister({ categories, onCreated, onBack }) {
  const [form, setForm] = useState({
    itemName: "",
    site: SITE_OPTIONS[0],
    submittedBy: "",
    categoryId: categories[0]?.id || "",
    toolImages: [],
    detailValues: {}
  });
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!form.categoryId && categories[0]?.id) {
      setForm((current) => ({ ...current, categoryId: categories[0].id }));
    }
  }, [categories, form.categoryId]);

  const category = categories.find((entry) => entry.id === form.categoryId);

  function updateBase(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function updateDetailValue(fieldId, value) {
    setForm((current) => ({ ...current, detailValues: { ...current.detailValues, [fieldId]: value } }));
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const created = await api.createRequest(form);
      saveRecentRequest({
        referenceId: created.referenceId,
        itemName: created.itemName,
        submittedBy: created.submittedBy,
        submittedAt: created.submittedAt
      });
      setMessage({
        type: "success",
        text: "Request submitted. The reference was saved on this device.",
        referenceId: created.referenceId
      });
      setForm({
        itemName: "",
        site: form.site || SITE_OPTIONS[0],
        submittedBy: "",
        categoryId: form.categoryId,
        toolImages: [],
        detailValues: {}
      });
      onCreated?.();
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="single-page tight-page">
      <section className="panel form-panel compact-panel">
        <div className="panel-heading compact-heading">
          <div>
            <p className="eyebrow">User</p>
            <h2>Register equipment</h2>
          </div>
          <button type="button" className="ghost-btn small" onClick={onBack}>Back</button>
        </div>

        {message && (
          <div className={cx("notice", message.type)}>
            <span>{message.text}</span>
            {message.referenceId && (
              <span className="reference-save-actions">
                <strong className="reference-chip">{message.referenceId}</strong>
                <button
                  type="button"
                  className="ghost-btn tiny"
                  onClick={() => copyText(message.referenceId).catch(() => alert("Could not copy the reference."))}
                >
                  <Copy size={13} /> Copy
                </button>
              </span>
            )}
          </div>
        )}

        <form onSubmit={submit} className="stack-form compact-form">
          <div className="form-row two">
            <label>
              Equipment Name <span>*</span>
              <input value={form.itemName} onChange={(event) => updateBase("itemName", event.target.value)} required />
            </label>
            <label>
              Site <span>*</span>
              <select value={form.site} onChange={(event) => updateBase("site", event.target.value)} required>
                {SITE_OPTIONS.map((site) => <option key={site} value={site}>{site}</option>)}
              </select>
            </label>
            <label>
              Submitted by <span>*</span>
              <input value={form.submittedBy} onChange={(event) => updateBase("submittedBy", event.target.value)} required />
            </label>
          </div>

          <label>
            Tool type <span>*</span>
            <select value={form.categoryId} onChange={(event) => updateBase("categoryId", event.target.value)} required>
              {categories.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
            </select>
          </label>

          <div className="dynamic-card tool-image-card">
            <div className="dynamic-head">
              <strong>Tool images</strong>
              <span>Add up to 8 images</span>
            </div>
            <MultiImageInput images={form.toolImages} onChange={(toolImages) => updateBase("toolImages", toolImages)} />
          </div>

          {(category?.detailFields || []).length > 0 && (
            <div className="dynamic-card equipment-details-card">
              <div className="dynamic-head">
                <div>
                  <strong>{category.name} details</strong>
                  <small>Configured by the Admin</small>
                </div>
                <ClipboardList size={18} />
              </div>
              <div className="dynamic-fields-grid">
                {(category.detailFields || []).map((field) => (
                  <label key={field.id} className={cx("dynamic-field", ["textarea", "image"].includes(field.type) && "wide")}>
                    {field.label} {field.required && <span>*</span>}
                    <FieldInput field={field} value={form.detailValues[field.id]} onChange={updateDetailValue} hidePlaceholder />
                  </label>
                ))}
              </div>
            </div>
          )}

          <button className="primary-btn" disabled={busy}>{busy ? "Submitting..." : "Submit request"}</button>
        </form>
      </section>
    </main>
  );
}

function ScanPage({ onOpenItem, onBack }) {
  const [lookupText, setLookupText] = useState("");
  const [recentRequests] = useState(() => readRecentRequests());
  const [error, setError] = useState("");
  const [referenceResult, setReferenceResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [scanPreview, setScanPreview] = useState(null);
  const isMobileDevice = useMemo(() => {
    if (typeof navigator === "undefined") return false;
    const ua = navigator.userAgent || "";
    const platform = navigator.platform || "";
    const iPadLike = platform === "MacIntel" && Number(navigator.maxTouchPoints || 0) > 1;
    return iPadLike || /Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(ua);
  }, []);

  useEffect(() => {
    return () => {
      if (scanPreview?.url) URL.revokeObjectURL(scanPreview.url);
    };
  }, [scanPreview?.url]);

  async function openItemFromDecodedText(decodedText, delayMs = 0) {
    const qrId = parseQrText(decodedText);
    if (!qrId) throw new Error("No QR text was found.");
    setLookupText(qrId);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    onOpenItem(qrId);
  }

  function pickLargestBox(boxes = []) {
    return [...boxes].sort((a, b) => (b.width * b.height) - (a.width * a.height))[0] || null;
  }

  function boxFromQrLocation(location) {
    if (!location) return null;
    const points = [
      location.topLeftCorner,
      location.topRightCorner,
      location.bottomRightCorner,
      location.bottomLeftCorner,
      location.topLeftFinderPattern,
      location.topRightFinderPattern,
      location.bottomLeftFinderPattern
    ].filter(Boolean);

    if (!points.length) return null;

    const xs = points.map((point) => point.x).filter((value) => Number.isFinite(value));
    const ys = points.map((point) => point.y).filter((value) => Number.isFinite(value));
    if (!xs.length || !ys.length) return null;

    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    return {
      x: minX,
      y: minY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY)
    };
  }

  async function loadImageElement(file) {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.decoding = "async";

    try {
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        image.src = objectUrl;
      });

      const naturalWidth = image.naturalWidth || image.width;
      const naturalHeight = image.naturalHeight || image.height;
      if (!naturalWidth || !naturalHeight) throw new Error("Could not read image size.");

      return { image, naturalWidth, naturalHeight, objectUrl };
    } catch (err) {
      URL.revokeObjectURL(objectUrl);
      throw err;
    }
  }

  function getCanvasDataFromImage(image, sourceSize, crop, maxDimension = 2400) {
    const scale = Math.min(1, maxDimension / Math.max(crop.sw, crop.sh));
    const width = Math.max(1, Math.round(crop.sw * scale));
    const height = Math.max(1, Math.round(crop.sh * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Could not read image pixels.");

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, width, height);

    return {
      imageData: context.getImageData(0, 0, width, height),
      canvasSize: { width, height },
      imageSize: sourceSize,
      crop
    };
  }

  function getPercentileFromHistogram(histogram, total, percentile) {
    const target = Math.max(0, Math.min(total - 1, Math.floor(total * percentile)));
    let cumulative = 0;
    for (let value = 0; value < histogram.length; value += 1) {
      cumulative += histogram[value];
      if (cumulative > target) return value;
    }
    return 255;
  }

  function getOtsuThreshold(histogram, total) {
    let sum = 0;
    for (let i = 0; i < 256; i += 1) sum += i * histogram[i];

    let sumBackground = 0;
    let weightBackground = 0;
    let bestVariance = -1;
    let threshold = 128;

    for (let i = 0; i < 256; i += 1) {
      weightBackground += histogram[i];
      if (!weightBackground) continue;

      const weightForeground = total - weightBackground;
      if (!weightForeground) break;

      sumBackground += i * histogram[i];
      const meanBackground = sumBackground / weightBackground;
      const meanForeground = (sum - sumBackground) / weightForeground;
      const variance = weightBackground * weightForeground * ((meanBackground - meanForeground) ** 2);

      if (variance > bestVariance) {
        bestVariance = variance;
        threshold = i;
      }
    }

    return threshold;
  }

  function enhanceImageData(imageData, mode) {
    if (mode === "normal") return imageData;

    const { width, height, data } = imageData;
    const output = new Uint8ClampedArray(data.length);
    const histogram = new Array(256).fill(0);
    const totalPixels = width * height;

    for (let index = 0; index < data.length; index += 4) {
      const lum = Math.max(0, Math.min(255, Math.round((data[index] * 0.299) + (data[index + 1] * 0.587) + (data[index + 2] * 0.114))));
      histogram[lum] += 1;
    }

    const low = getPercentileFromHistogram(histogram, totalPixels, 0.03);
    const high = Math.max(low + 8, getPercentileFromHistogram(histogram, totalPixels, 0.97));
    const threshold = getOtsuThreshold(histogram, totalPixels);

    for (let index = 0; index < data.length; index += 4) {
      const lum = Math.max(0, Math.min(255, Math.round((data[index] * 0.299) + (data[index + 1] * 0.587) + (data[index + 2] * 0.114))));
      let value;

      if (mode === "threshold") {
        value = lum > threshold ? 255 : 0;
      } else if (mode === "highContrast") {
        const stretched = ((lum - low) / (high - low)) * 255;
        value = Math.max(0, Math.min(255, Math.round(((stretched - 128) * 1.28) + 128)));
      } else if (mode === "brightContrast") {
        const stretched = ((lum - low) / (high - low)) * 255;
        value = Math.max(0, Math.min(255, Math.round((stretched * 1.12) + 14)));
      } else {
        value = lum;
      }

      output[index] = value;
      output[index + 1] = value;
      output[index + 2] = value;
      output[index + 3] = data[index + 3];
    }

    return new ImageData(output, width, height);
  }

  function translateCanvasBoxToSource(box, canvasData) {
    if (!box) return null;
    const { crop, canvasSize } = canvasData;
    const scaleX = crop.sw / canvasSize.width;
    const scaleY = crop.sh / canvasSize.height;

    return {
      x: crop.sx + (box.x * scaleX),
      y: crop.sy + (box.y * scaleY),
      width: Math.max(1, box.width * scaleX),
      height: Math.max(1, box.height * scaleY)
    };
  }

  function withTimeout(promise, ms, label = "Operation") {
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        window.setTimeout(() => reject(new Error(`${label} timed out.`)), ms);
      })
    ]);
  }

  function makeCropPlans(width, height) {
    const plans = [];
    const seen = new Set();
    const addPlan = (name, sx, sy, sw, sh, maxDimension = 1200, modes = ["normal"]) => {
      const safeSw = Math.min(width, Math.max(120, sw));
      const safeSh = Math.min(height, Math.max(120, sh));
      const safeSx = Math.max(0, Math.min(width - safeSw, sx));
      const safeSy = Math.max(0, Math.min(height - safeSh, sy));
      const key = [safeSx, safeSy, safeSw, safeSh].map((value) => Math.round(value / 20) * 20).join(":");
      if (seen.has(key)) return;
      seen.add(key);
      plans.push({ name, sx: safeSx, sy: safeSy, sw: safeSw, sh: safeSh, maxDimension, modes });
    };

    // Keep the default scan intentionally small. Huge phone photos were making
    // jsQR spend minutes on pixels, so we downscale and scan fewer smart regions.
    addPlan("full", 0, 0, width, height, 1280, ["normal", "highContrast"]);

    [0.78, 0.58].forEach((ratio) => {
      const sw = width * ratio;
      const sh = height * ratio;
      addPlan(`center-${Math.round(ratio * 100)}`, (width - sw) / 2, (height - sh) / 2, sw, sh, 1350, ["normal", "highContrast"]);
    });

    // Quick 3x3 pass. This gives leeway when the QR is off-center without
    // scanning dozens of expensive filtered copies.
    const gridRatio = 0.54;
    const gridSw = width * gridRatio;
    const gridSh = height * gridRatio;
    [0, 0.5, 1].forEach((xPos) => {
      [0, 0.5, 1].forEach((yPos) => {
        addPlan(`grid-${xPos}-${yPos}`, (width - gridSw) * xPos, (height - gridSh) * yPos, gridSw, gridSh, 1200, ["normal"]);
      });
    });

    // One final center threshold pass helps dim photos, but keep it small.
    const finalRatio = 0.68;
    const finalSw = width * finalRatio;
    const finalSh = height * finalRatio;
    addPlan("center-threshold", (width - finalSw) / 2, (height - finalSh) / 2, finalSw, finalSh, 1250, ["threshold"]);

    return plans;
  }

  function scanCanvasDataWithJsQr(jsQR, canvasData, mode = "normal") {
    const scanData = mode === "normal" ? canvasData.imageData : enhanceImageData(canvasData.imageData, mode);
    const result = jsQR(scanData.data, canvasData.canvasSize.width, canvasData.canvasSize.height, {
      inversionAttempts: "attemptBoth"
    });

    if (!result?.data) return null;

    const box = translateCanvasBoxToSource(boxFromQrLocation(result.location), canvasData);
    return {
      decodedText: result.data,
      boxes: box ? [box] : [],
      imageSize: canvasData.imageSize,
      detector: mode === "normal" ? "smart-jsqr" : `smart-jsqr-${mode}`
    };
  }

  async function trySmartJsQr(file) {
    const { default: jsQR } = await import("jsqr");
    const loaded = await loadImageElement(file);

    try {
      const sourceSize = { width: loaded.naturalWidth, height: loaded.naturalHeight };
      const cropPlans = makeCropPlans(loaded.naturalWidth, loaded.naturalHeight);

      for (const crop of cropPlans) {
        const canvasData = getCanvasDataFromImage(loaded.image, sourceSize, crop, crop.maxDimension);
        for (const mode of crop.modes || ["normal"]) {
          const decoded = scanCanvasDataWithJsQr(jsQR, canvasData, mode);
          if (decoded?.decodedText) return { ...decoded, detector: `${decoded.detector}-${crop.name}` };
        }
      }
    } finally {
      URL.revokeObjectURL(loaded.objectUrl);
    }

    throw new Error("No QR code detected.");
  }

  async function tryBarcodeDetector(file) {
    if (typeof window === "undefined" || !("BarcodeDetector" in window) || typeof createImageBitmap !== "function") {
      throw new Error("Native barcode detector is not available.");
    }

    const formats = await window.BarcodeDetector.getSupportedFormats?.().catch(() => []) || [];
    const detector = new window.BarcodeDetector({ formats: formats.includes("qr_code") ? ["qr_code"] : undefined });
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => createImageBitmap(file));

    try {
      const results = await detector.detect(bitmap);
      const qrResults = results.filter((entry) => entry.rawValue);
      if (!qrResults.length) throw new Error("No QR code detected.");

      const boxes = qrResults
        .filter((entry) => entry.boundingBox)
        .map((entry) => ({
          x: entry.boundingBox.x,
          y: entry.boundingBox.y,
          width: entry.boundingBox.width,
          height: entry.boundingBox.height
        }));

      const selectedBox = pickLargestBox(boxes);
      const selected = selectedBox
        ? qrResults.find((entry) => entry.boundingBox && entry.boundingBox.x === selectedBox.x && entry.boundingBox.y === selectedBox.y) || qrResults[0]
        : qrResults[0];

      return {
        decodedText: selected.rawValue,
        boxes: selectedBox ? [selectedBox] : [],
        imageSize: { width: bitmap.width, height: bitmap.height },
        detector: "native"
      };
    } finally {
      bitmap.close?.();
    }
  }

  async function tryHtml5QrCode(file) {
    const { Html5Qrcode } = await import("html5-qrcode");
    const scanner = new Html5Qrcode("qr-upload-reader", { verbose: false });
    try {
      const decodedText = await scanner.scanFile(file, false);
      return { decodedText, boxes: [], imageSize: null, detector: "html5-qrcode" };
    } finally {
      try {
        await scanner.clear();
      } catch {
        // scanFile does not always create a persistent scanner instance.
      }
    }
  }

  async function decodeQrFromFile(file) {
    const errors = [];

    // Native detector is fast when Chrome/Android supports it. Do not let it hang.
    try {
      return await withTimeout(tryBarcodeDetector(file), 1800, "Native QR scan");
    } catch (err) {
      errors.push(err?.message || "Native detector failed");
    }

    // Fast jsQR pass: downscaled full image + a small set of smart crops.
    try {
      return await withTimeout(trySmartJsQr(file), 4500, "Fast QR scan");
    } catch (err) {
      errors.push(err?.message || "Fast QR scan failed");
    }

    throw new Error(errors.join(" | "));
  }

  async function handleQrPhoto(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setError("Please take or upload an image of a QR code.");
      return;
    }

    const previewUrl = URL.createObjectURL(file);
    setError("");
    setReferenceResult(null);
    setImageBusy(true);
    setScanPreview((current) => {
      if (current?.url) URL.revokeObjectURL(current.url);
      return {
        url: previewUrl,
        status: "scanning",
        message: "Fast scanning image and smart QR crops...",
        decodedText: "",
        boxes: [],
        imageSize: null,
        detector: ""
      };
    });

    try {
      const decoded = await decodeQrFromFile(file);
      const qrId = parseQrText(decoded.decodedText);
      setScanPreview((current) => ({
        ...(current || {}),
        url: previewUrl,
        status: "detected",
        message: decoded.boxes?.length
          ? `Detected ${qrId}. Green border marks the QR used.`
          : `Detected ${qrId}. Exact QR border is not available in this browser.`,
        decodedText: qrId,
        boxes: decoded.boxes || [],
        imageSize: decoded.imageSize || null,
        detector: decoded.detector || ""
      }));
      await openItemFromDecodedText(decoded.decodedText, 700);
    } catch (err) {
      setScanPreview((current) => ({
        ...(current || {}),
        url: previewUrl,
        status: "failed",
        message: "No readable QR code found.",
        decodedText: "",
        boxes: [],
        imageSize: null,
        detector: ""
      }));
      setError("Could not read it quickly. Retake with the whole QR visible and make the QR fill more of the photo, or use manual QR / Reference ID below.");
    } finally {
      setImageBusy(false);
    }
  }

  async function checkLookup(rawValue) {
    const value = rawValue.trim();
    const normalized = value.toUpperCase();
    if (!value) return setError("Enter a QR ID or Reference ID first.");

    setLookupText(value);
    setError("");
    setReferenceResult(null);

    if (normalized.startsWith("REF-")) {
      setBusy(true);
      try {
        const data = await api.requestByReference(normalized);
        setReferenceResult(data);
      } catch (err) {
        setError(err.message);
      } finally {
        setBusy(false);
      }
      return;
    }

    onOpenItem(parseQrText(value));
  }

  async function manualSubmit(event) {
    event.preventDefault();
    await checkLookup(lookupText);
  }

  return (
    <main className="single-page tight-page">
      <section className="panel scanner-panel compact-panel">
        <div className="panel-heading compact-heading">
          <div>
            <p className="eyebrow">User</p>
            <h2>Follow up</h2>
          </div>
          <button type="button" className="ghost-btn small" onClick={onBack}>Back</button>
        </div>

        {error && <div className="notice error">{error}</div>}

        <div className="scanner-box capture-box">
          {scanPreview?.url ? (
            <div className={cx("scan-preview", scanPreview.status)}>
              <img src={scanPreview.url} alt="QR scan preview" />
              {scanPreview.boxes?.length > 0 && scanPreview.imageSize ? (
                scanPreview.boxes.map((box, index) => (
                  <span
                    key={`${box.x}-${box.y}-${index}`}
                    className="scan-detected-box"
                    style={{
                      left: `${(box.x / scanPreview.imageSize.width) * 100}%`,
                      top: `${(box.y / scanPreview.imageSize.height) * 100}%`,
                      width: `${(box.width / scanPreview.imageSize.width) * 100}%`,
                      height: `${(box.height / scanPreview.imageSize.height) * 100}%`
                    }}
                  />
                ))
              ) : (
                <span className="scan-frame" />
              )}
              <div className={cx("scan-state", scanPreview.status)}>
                <strong>{scanPreview.status === "detected" ? "QR detected" : scanPreview.status === "failed" ? "Try again" : "Scanning"}</strong>
                <span>{scanPreview.message}</span>
              </div>
            </div>
          ) : (
            <>
              <ScanLine size={27} />
              <div className="capture-copy">
                <strong>{isMobileDevice ? "Take QR photo" : "Upload QR image"}</strong>
              </div>
            </>
          )}

          <div className="capture-actions">
            <label className="primary-btn file-action">
              <Camera size={15} />
              {imageBusy ? "Reading..." : isMobileDevice ? "Take / upload QR photo" : "Upload QR image"}
              <input
                type="file"
                accept="image/*"
                capture={isMobileDevice ? "environment" : undefined}
                onChange={handleQrPhoto}
                disabled={imageBusy}
              />
            </label>
            {scanPreview?.url && (
              <button
                type="button"
                className="ghost-btn small"
                onClick={() => {
                  setScanPreview((current) => {
                    if (current?.url) URL.revokeObjectURL(current.url);
                    return null;
                  });
                  setError("");
                }}
              >
                Clear photo
              </button>
            )}
          </div>
          <div id="qr-upload-reader" className="qr-upload-reader" aria-hidden="true" />
        </div>

        <form onSubmit={manualSubmit} className="followup-check">
          <label>
            QR ID / Reference ID
            <input value={lookupText} onChange={(event) => setLookupText(event.target.value)} placeholder="QR-XXXXXXXX or REF-XXXXXXXX" />
          </label>
          <button className="secondary-btn" disabled={busy}>{busy ? "Checking" : "Check"}</button>
        </form>

        {recentRequests.length > 0 && (
          <div className="recent-requests">
            <div className="recent-requests-heading">
              <strong>Recent registrations on this device</strong>
              <span>No need to remember the reference</span>
            </div>
            <div className="recent-request-list">
              {recentRequests.map((entry) => (
                <button
                  type="button"
                  key={entry.referenceId}
                  onClick={() => checkLookup(entry.referenceId)}
                  disabled={busy}
                >
                  <span>
                    <strong>{entry.itemName || "Registered tool"}</strong>
                    <small>{entry.referenceId}</small>
                  </span>
                  <Search size={14} />
                </button>
              ))}
            </div>
          </div>
        )}

        {referenceResult && (
          <div className={cx("reference-result", referenceResult.status, referenceResult.qrImageDataUrl && "with-qr") }>
            <div>
              <strong>{referenceResult.itemName}</strong>
              <span>{referenceResult.referenceId} • {referenceResult.site}</span>
              {(referenceResult.reviewedBy || referenceResult.rejectedBy) && (
                <small>Reviewed by {referenceResult.reviewedBy || referenceResult.rejectedBy}</small>
              )}
              {referenceResult.reviewNote && <small>Feedback: {referenceResult.reviewNote}</small>}
            </div>
            {referenceResult.qrImageDataUrl && (
              <div className="reference-qr-card">
                <img src={referenceResult.qrImageDataUrl} alt={`QR for ${referenceResult.itemName}`} />
                <small>{referenceResult.qrId}</small>
              </div>
            )}
            <div className="reference-actions">
              <span className={cx("status-badge", referenceResult.status)}>{referenceResult.status === "accepted" ? "Accepted" : referenceResult.status === "rejected" ? "Rejected" : "Pending"}</span>
              {referenceResult.qrId && <button type="button" className="ghost-btn tiny" onClick={() => onOpenItem(referenceResult.qrId)}>Open QR</button>}
              <DownloadQrLink
                qrImageDataUrl={referenceResult.qrImageDataUrl}
                itemCode={referenceResult.itemCode}
                itemName={referenceResult.itemName}
                qrId={referenceResult.qrId}
                referenceId={referenceResult.referenceId}
              />
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

function ItemDetails({ qrId, onBack, staffSession, reload }) {
  const [item, setItem] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [showChecklist, setShowChecklist] = useState(false);
  const [showRenewal, setShowRenewal] = useState(false);
  const [renewalDate, setRenewalDate] = useState("");
  const [renewalAnswers, setRenewalAnswers] = useState({});
  const [renewalFeedback, setRenewalFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const canManage = ["reviewer", "admin"].includes(staffSession?.role);

  useEffect(() => {
    if (!qrId) return;
    setLoading(true);
    setError("");
    api.itemByQr(qrId)
      .then((data) => {
        setItem(data);
        setShowRenewal(false);
        setRenewalDate("");
        setRenewalAnswers({});
        setRenewalFeedback("");
        return api.trackUsageEvent({
          type: "qr_open",
          targetId: qrId,
          sessionId: getVisitSessionId(),
          path: window.location.pathname
        }).catch(() => null);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [qrId]);

  function toggleChecklist() {
    const next = !showChecklist;
    setShowChecklist(next);
    if (next) {
      api.trackUsageEvent({
        type: "checklist_view",
        targetId: qrId,
        sessionId: getVisitSessionId(),
        path: window.location.pathname
      }).catch(() => null);
    }
  }

  function updateRenewalAnswer(fieldId, value) {
    setRenewalAnswers((current) => ({ ...current, [fieldId]: value }));
  }

  async function renew() {
    if (!item) return;
    setBusy(true);
    try {
      const updated = await api.renewItem(item.id, {
        expiresAt: renewalDate,
        reviewAnswers: renewalAnswers,
        reviewNote: renewalFeedback,
        role: staffSession.role,
        renewedBy: staffSession.displayName || staffSession.username
      });
      setItem(updated);
      setShowRenewal(false);
      setRenewalDate("");
      setRenewalAnswers({});
      setRenewalFeedback("");
      await reload?.({ silent: true });
    } catch (actionError) {
      alert(actionError.message);
    } finally {
      setBusy(false);
    }
  }

  async function archiveToggle() {
    if (!item) return;
    setBusy(true);
    try {
      const updated = item.archivedAt
        ? await api.restoreItem(item.id)
        : await api.archiveItem(item.id, { archiveNote: "Archived from tool details" });
      setItem(updated);
      await reload?.({ silent: true });
    } catch (actionError) {
      alert(actionError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="single-page tight-page">
      <section className="panel detail-panel compact-panel">
        <button className="ghost-btn small back-btn" onClick={onBack}>← Back</button>
        {loading && <EmptyState icon={RefreshCw} title="Checking QR..." message="Loading tool details and validity status." />}
        {error && <EmptyState icon={XCircle} title="QR not found" message={error} />}
        {item && !loading && (
          <>
            <div className={cx("validity-banner", item.validity?.status)}>
              <div className="validity-copy">
                {item.validity?.status === "valid" ? <CheckCircle2 size={30} /> : <XCircle size={30} />}
                <div>
                  <p>Power Tool validity</p>
                  <h1>{item.validity?.status === "valid" ? "This tool is still GOOD" : item.validity?.status === "expired" ? "This tool QR is EXPIRED" : "This tool is ARCHIVED"}</h1>
                  <span>{item.validity?.status === "valid" ? `${item.validity?.daysLeft ?? "—"} day(s) left` : `Expiry date: ${formatDate(item.expiresAt)}`}</span>
                </div>
              </div>
              <div className="validity-qr-card">
                <img src={item.qrImageDataUrl} alt={`QR for ${item.itemName}`} />
                <div>
                  <span>{item.referenceId ? `Ref: ${item.referenceId}` : item.qrId}</span>
                  <DownloadQrLink
                    qrImageDataUrl={item.qrImageDataUrl}
                    itemCode={item.itemCode}
                    itemName={item.itemName}
                    qrId={item.qrId}
                    referenceId={item.referenceId}
                    className="ghost-btn tiny qr-download-link"
                  />
                </div>
              </div>
            </div>

            <div className="detail-title-row">
              <div>
                <p className="eyebrow">{item.toolType || item.categoryName}</p>
                <h2>{item.itemName}</h2>
                <p className="muted">QR: {item.qrId}{item.referenceId ? ` • Ref: ${item.referenceId}` : ""}</p>
              </div>
              <StatusBadge validity={item.validity} />
            </div>

            <div className="detail-grid">
              <div><span>Tool type</span><strong>{item.toolType || item.categoryName}</strong></div>
              <div><span>Site</span><strong>{item.site}</strong></div>
              <div><span>Registered</span><strong>{formatDateTime(item.registeredAt)}</strong></div>
              <div><span>Expires</span><strong>{formatDate(item.expiresAt)}</strong></div>
              <div><span>Submitted by</span><strong>{item.submittedBy || "—"}</strong></div>
              <div><span>Reviewed by</span><strong>{item.reviewedBy || "—"}</strong></div>
            </div>

            <div className="qr-detail-columns">
              <ToolImageGallery record={item} />

              {(item.detailsSnapshot || []).length > 0 && (
                <div className="details-list power-summary">
                  <h3><ClipboardList size={16} /> Equipment details</h3>
                  <FieldRows fields={item.detailsSnapshot} values={item.detailValues || {}} />
                </div>
              )}
            </div>

            <div className="details-list checklist-panel">
              <div className="checklist-title-row">
                <div>
                  <h3>Review questions</h3>
                  <p className="muted small-text">{(item.reviewQuestionsSnapshot || []).length} answered question(s)</p>
                </div>
                <button type="button" className="secondary-btn small" onClick={toggleChecklist}>
                  <ListChecks size={15} /> {showChecklist ? "Hide review" : "View review questions"}
                </button>
              </div>
              {showChecklist && (
                <>
                  <ReviewAnswerSummary
                    questions={item.reviewQuestionsSnapshot || []}
                    answers={item.reviewAnswers || {}}
                  />
                  <ReviewerFeedback
                    note={item.reviewNote}
                    reviewedBy={item.reviewedBy}
                    reviewedAt={item.updatedAt || item.approvedAt}
                  />
                </>
              )}
            </div>

            {canManage && item.validity?.status === "expired" && showRenewal && (
              <div className="details-list renewal-panel">
                <div className="renewal-heading">
                  <div>
                    <p className="eyebrow">Expired item</p>
                    <h3>Renew after the next inspection</h3>
                  </div>
                  <span>Checked by {staffSession.displayName || staffSession.username}</span>
                </div>
                <div className="reviewer-form">
                  {(item.reviewQuestionsSnapshot || []).map((question) => (
                    <label key={question.id} className="review-question-field">
                      <span>{question.label} {question.required && "*"}</span>
                      <FieldInput field={question} value={renewalAnswers[question.id]} onChange={updateRenewalAnswer} />
                    </label>
                  ))}
                </div>
                <div className="renewal-fields">
                  <label>
                    New next-check date
                    <input type="date" value={renewalDate} onChange={(event) => setRenewalDate(event.target.value)} />
                  </label>
                  <label>
                    Reviewer feedback
                    <textarea value={renewalFeedback} onChange={(event) => setRenewalFeedback(event.target.value)} placeholder="Inspection findings or renewal remarks" />
                  </label>
                </div>
                <div className="button-row renewal-actions">
                  <button
                    type="button"
                    className="primary-btn small mobile-review-action"
                    onClick={renew}
                    disabled={busy || !renewalDate}
                    aria-label="Renew tool"
                    title="Renew tool"
                  >
                    <CheckCircle2 size={15} />
                    <span className="review-action-label">Renew tool</span>
                  </button>
                  <button
                    type="button"
                    className="ghost-btn small mobile-review-action"
                    onClick={() => setShowRenewal(false)}
                    disabled={busy}
                    aria-label="Cancel renewal"
                    title="Cancel"
                  >
                    <XCircle size={15} />
                    <span className="review-action-label">Cancel</span>
                  </button>
                </div>
              </div>
            )}

            {canManage && (
              <div className="detail-action-bar archive-only">
                {item.validity?.status === "expired" && !showRenewal && (
                  <button
                    type="button"
                    className="primary-btn small mobile-review-action"
                    onClick={() => setShowRenewal(true)}
                    disabled={busy}
                    aria-label="Renew expired tool"
                    title="Renew expired tool"
                  >
                    <RefreshCw size={15} />
                    <span className="review-action-label">Renew expired tool</span>
                  </button>
                )}
                <button
                  type="button"
                  className="danger-btn small subtle mobile-review-action"
                  onClick={archiveToggle}
                  disabled={busy}
                  aria-label={item.archivedAt ? "Restore tool" : "Archive tool"}
                  title={item.archivedAt ? "Restore" : "Archive"}
                >
                  {item.archivedAt ? <RefreshCw size={15} /> : <Archive size={15} />}
                  <span className="review-action-label">{item.archivedAt ? "Restore" : "Archive"}</span>
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}

function RequestDetails({ requestId, onBack, onApproved, staffSession, reload }) {
  const [request, setRequest] = useState(null);
  const [reviewAnswers, setReviewAnswers] = useState({});
  const [note, setNote] = useState("");
  const [showReview, setShowReview] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!requestId) return;
    setLoading(true);
    setError("");
    api.requestById(requestId)
      .then((data) => {
        setRequest(data);
        setReviewAnswers(data.reviewAnswers || {});
        setNote(data.reviewNote || "");
      })
      .catch((loadError) => setError(loadError.message))
      .finally(() => setLoading(false));
  }, [requestId]);

  const canAct = request ? canStaffActOnRequest(staffSession, request) : false;
  const questions = request?.reviewQuestionsSnapshot || [];
  const hasAutomaticDecision = questions.some((question) => question.autoDecision?.enabled);
  const finalStatus = request?.archivedAt ? "archived" : request?.status;

  function updateReviewAnswer(fieldId, value) {
    setReviewAnswers((current) => ({ ...current, [fieldId]: value }));
  }

  async function decide(decision) {
    if (!request) return;
    setBusy(true);
    try {
      const payload = {
        reviewNote: note,
        reviewAnswers,
        role: staffSession.role,
        approvedBy: staffSession.displayName || staffSession.username,
        rejectedBy: staffSession.displayName || staffSession.username
      };
      if (decision === "approved") {
        const result = await api.approveRequest(request.id, payload);
        await reload?.({ silent: true });
        onApproved(result.item.qrId);
      } else {
        const updated = await api.rejectRequest(request.id, payload);
        setRequest(updated);
        await reload?.({ silent: true });
      }
    } catch (actionError) {
      alert(actionError.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitAutomaticReview() {
    if (!request) return;
    setBusy(true);
    try {
      const result = await api.reviewRequest(request.id, {
        reviewNote: note,
        reviewAnswers,
        role: staffSession.role,
        reviewedBy: staffSession.displayName || staffSession.username
      });
      await reload?.({ silent: true });
      if (result.decision === "approved") {
        onApproved(result.item.qrId);
      } else {
        setRequest(result.request);
      }
    } catch (actionError) {
      alert(actionError.message);
    } finally {
      setBusy(false);
    }
  }

  async function archiveToggle() {
    if (!request) return;
    setBusy(true);
    try {
      const updated = request.archivedAt
        ? await api.restoreRequest(request.id)
        : await api.archiveRequest(request.id, { archiveNote: "Archived from request details" });
      setRequest(updated);
      await reload?.({ silent: true });
    } catch (actionError) {
      alert(actionError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="single-page tight-page">
      <section className="panel detail-panel compact-panel">
        <button className="ghost-btn small back-btn" onClick={onBack}>← Back</button>
        {loading && <EmptyState icon={RefreshCw} title="Loading request..." message="Opening the submitted equipment details." />}
        {error && <EmptyState icon={XCircle} title="Request not found" message={error} />}
        {request && !loading && (
          <>
            <div className={cx("request-detail-banner", finalStatus)}>
              {finalStatus === "pending" ? <Bell size={30} /> : finalStatus === "rejected" ? <XCircle size={30} /> : <Archive size={30} />}
              <div>
                <p>Power Tool review</p>
                <h1>{finalStatus === "pending" ? "This request is awaiting review" : finalStatus === "rejected" ? "This request was REJECTED" : "This request is ARCHIVED"}</h1>
                <span>Reference: {request.referenceId}</span>
              </div>
            </div>

            <div className="detail-title-row">
              <div>
                <p className="eyebrow">{request.toolType || request.categoryName}</p>
                <h2>{request.itemName}</h2>
                <p className="muted">Ref: {request.referenceId}</p>
              </div>
              <StatusBadge status={finalStatus} />
            </div>

            <div className="detail-grid">
              <div><span>Tool type</span><strong>{request.toolType || request.categoryName}</strong></div>
              <div><span>Site</span><strong>{request.site}</strong></div>
              <div><span>Submitted</span><strong>{formatDateTime(request.submittedAt)}</strong></div>
              <div><span>Submitted by</span><strong>{request.submittedBy || "—"}</strong></div>
              {request.status !== "pending" && <div><span>Reviewed by</span><strong>{request.reviewedBy || request.rejectedBy || "—"}</strong></div>}
            </div>

            <div className="qr-detail-columns">
              <ToolImageGallery record={request} />
              {(request.detailsSnapshot || []).length > 0 && (
                <div className="details-list power-summary">
                  <h3><ClipboardList size={16} /> Equipment details</h3>
                  <FieldRows fields={request.detailsSnapshot || []} values={request.detailValues || {}} />
                </div>
              )}
            </div>

            {request.status === "pending" ? (
              <div className="details-list reviewer-form">
                <h3>Review questions</h3>
                {questions.length === 0 ? (
                  <p className="muted">No review questions configured.</p>
                ) : (
                  questions.map((question) => (
                    <label key={question.id} className="review-question-field">
                      <span>
                        {question.label} {question.required && "*"}
                        {question.autoDecision?.enabled && <small className="auto-rule-badge">Automatic result</small>}
                      </span>
                      <FieldInput field={question} value={reviewAnswers[question.id]} onChange={updateReviewAnswer} />
                    </label>
                  ))
                )}
              </div>
            ) : (
              <div className="details-list checklist-panel">
                <div className="checklist-title-row">
                  <div>
                    <h3>Review questions</h3>
                    <p className="muted small-text">{questions.length} answered question(s)</p>
                  </div>
                  <button type="button" className="secondary-btn small" onClick={() => setShowReview((current) => !current)}>
                    <ListChecks size={15} /> {showReview ? "Hide review" : "View review questions"}
                  </button>
                </div>
                {showReview && (
                  <>
                    <ReviewAnswerSummary questions={questions} answers={request.reviewAnswers || {}} />
                    <ReviewerFeedback
                      note={request.reviewNote}
                      reviewedBy={request.reviewedBy || request.rejectedBy}
                      reviewedAt={request.reviewedAt}
                    />
                  </>
                )}
              </div>
            )}

            {request.status === "pending" && (
              <div className="approval-box detail-approval-bar">
                <label>
                  Reviewer feedback
                  <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Inspection findings or reason for the decision" disabled={!canAct} />
                </label>
                <div className="button-row">
                  {hasAutomaticDecision ? (
                    <button
                      className="primary-btn small mobile-review-action"
                      disabled={busy || !canAct}
                      onClick={submitAutomaticReview}
                      aria-label={busy ? "Submitting review" : "Submit review"}
                      title="Submit review"
                    >
                      <ListChecks size={15} />
                      <span className="review-action-label">{busy ? "Submitting..." : "Submit review"}</span>
                    </button>
                  ) : (
                    <>
                      <button
                        className="primary-btn small mobile-review-action"
                        disabled={busy || !canAct}
                        onClick={() => decide("approved")}
                        aria-label="Approve request"
                        title="Approve"
                      >
                        <CheckCircle2 size={15} />
                        <span className="review-action-label">Approve</span>
                      </button>
                      <button
                        className="danger-btn small mobile-review-action"
                        disabled={busy || !canAct}
                        onClick={() => decide("rejected")}
                        aria-label="Reject request"
                        title="Reject"
                      >
                        <XCircle size={15} />
                        <span className="review-action-label">Reject</span>
                      </button>
                    </>
                  )}
                </div>
                {hasAutomaticDecision && (
                  <p className="auto-decision-note">Configured answers will automatically approve or reject this request.</p>
                )}
              </div>
            )}

            {request.status === "rejected" && (
              <div className="detail-action-bar archive-only">
                <button
                  type="button"
                  className="danger-btn small subtle mobile-review-action"
                  onClick={archiveToggle}
                  disabled={busy}
                  aria-label={request.archivedAt ? "Restore request" : "Archive request"}
                  title={request.archivedAt ? "Restore" : "Archive"}
                >
                  {request.archivedAt ? <RefreshCw size={15} /> : <Archive size={15} />}
                  <span className="review-action-label">{request.archivedAt ? "Restore" : "Archive"}</span>
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}

function StaffLogin({ onLogin }) {
  const [form, setForm] = useState({ username: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const session = await api.login({
        ...form,
        sessionId: getVisitSessionId(),
        path: window.location.pathname
      });
      onLogin(session);
    } catch (loginError) {
      setError(loginError.message || "Login failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="single-page staff-login-page">
      <section className="panel login-panel staff-login-panel">
        <div className="panel-heading compact-heading">
          <div>
            <p className="eyebrow">Secure access</p>
            <h2>Reviewer account</h2>
          </div>
          <KeyRound size={24} />
        </div>
        {error && <div className="notice error">{error}</div>}
        <form onSubmit={submit} className="stack-form">
          <label>
            Username
            <input value={form.username} onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))} placeholder="Enter username" autoComplete="username" autoFocus />
          </label>
          <label>
            Password
            <input type="password" value={form.password} onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))} placeholder="Enter password" autoComplete="current-password" />
          </label>
          <button className="primary-btn" disabled={busy}>{busy ? "Checking..." : "Sign in"}</button>
        </form>
      </section>
    </main>
  );
}

function ReviewerAccounts({ adminSession }) {
  const [accounts, setAccounts] = useState([]);
  const [form, setForm] = useState({ username: "", password: "" });
  const [pendingCreation, setPendingCreation] = useState(false);
  const [createPassword, setCreatePassword] = useState("");
  const [pendingRemoval, setPendingRemoval] = useState(null);
  const [removePassword, setRemovePassword] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [message, setMessage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  function sortAccounts(nextAccounts) {
    return [...nextAccounts].sort((a, b) => {
      if (a.role !== b.role) return a.role === "admin" ? -1 : 1;
      return a.username.localeCompare(b.username);
    });
  }

  async function loadAccounts() {
    setLoading(true);
    try {
      setAccounts(await api.staffAccounts(adminSession.username));
    } catch (loadError) {
      setMessage({ type: "error", text: loadError.message });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminSession.username]);

  function requestCreateConfirmation(event) {
    event.preventDefault();
    setCreatePassword("");
    setDialogError("");
    setMessage(null);
    setPendingCreation(true);
  }

  async function createAccount(event) {
    event.preventDefault();
    setBusy(true);
    setDialogError("");
    try {
      const account = await api.createReviewerAccount({
        ...form,
        adminUsername: adminSession.username,
        adminPassword: createPassword
      });
      setAccounts((current) => sortAccounts([...current, account]));
      setForm({ username: "", password: "" });
      setCreatePassword("");
      setPendingCreation(false);
      setMessage({ type: "success", text: `${account.username} can now sign in as a Reviewer.` });
    } catch (createError) {
      setDialogError(createError.message);
    } finally {
      setBusy(false);
    }
  }

  async function removeAccount(event) {
    event.preventDefault();
    if (!pendingRemoval) return;
    setBusy(true);
    setDialogError("");
    try {
      await api.deleteReviewerAccount(pendingRemoval.id, {
        adminUsername: adminSession.username,
        adminPassword: removePassword
      });
      setAccounts((current) => current.filter((entry) => entry.id !== pendingRemoval.id));
      setMessage({ type: "success", text: `${pendingRemoval.username}'s sign-in account was removed.` });
      setPendingRemoval(null);
      setRemovePassword("");
    } catch (removeError) {
      setDialogError(removeError.message);
    } finally {
      setBusy(false);
    }
  }

  const reviewerCount = accounts.filter((account) => account.role === "reviewer").length;

  return (
    <section className="admin-section accounts-admin">
      <div className="section-head accounts-heading">
        <div>
          <p className="eyebrow">Admin only</p>
          <h2>Accounts</h2>
        </div>
        <span className="quick-count"><strong>{accounts.length}</strong><small>accounts</small></span>
      </div>
      {message && <div className={cx("notice", message.type)}>{message.text}</div>}

      <div className="accounts-layout">
        <form className="reviewer-account-form" onSubmit={requestCreateConfirmation}>
          <div className="account-form-title">
            <span className="account-title-icon"><UserPlus size={20} /></span>
            <div>
              <p className="eyebrow">New access</p>
              <h3>Add Reviewer</h3>
            </div>
          </div>
          <div className="account-fields">
            <label>
              Username
              <input value={form.username} onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))} placeholder="Reviewer username" autoComplete="off" required />
            </label>
            <label>
              Password
              <input type="password" value={form.password} onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))} placeholder="At least 4 characters" autoComplete="new-password" required />
            </label>
          </div>
          <button className="primary-btn account-submit" disabled={busy}><UserPlus size={15} /> Add Reviewer account</button>
        </form>

        <div className="reviewer-account-list">
          <div className="account-list-title">
            <div>
              <span className="account-title-icon"><ShieldCheck size={18} /></span>
              <div>
                <p className="eyebrow">Access control</p>
                <h3>Authorized accounts</h3>
              </div>
            </div>
            {!loading && <span>{reviewerCount} {reviewerCount === 1 ? "Reviewer" : "Reviewers"}</span>}
          </div>
          {loading ? (
            <EmptyState icon={RefreshCw} title="Loading accounts..." message="Reading saved accounts." />
          ) : accounts.length === 0 ? (
            <EmptyState icon={UserCircle} title="No accounts" message="No accounts are available." />
          ) : accounts.map((account) => (
            <div className={cx("reviewer-account-row", account.role === "admin" && "protected-account")} key={account.id}>
              <span className="reviewer-avatar">{account.username.slice(0, 1).toUpperCase()}</span>
              <div>
                <strong>{account.username}</strong>
                <span>{account.role === "admin" ? "Admin • Protected account" : `Reviewer • Added ${formatDate(account.createdAt)}`}</span>
              </div>
              {account.role === "admin" ? (
                <span className="protected-badge"><ShieldCheck size={13} /> Cannot remove</span>
              ) : (
                <button type="button" className="danger-btn tiny subtle" onClick={() => {
                  setPendingRemoval(account);
                  setRemovePassword("");
                  setDialogError("");
                  setMessage(null);
                }} disabled={busy || reviewerCount <= 1}>
                  <Trash2 size={14} /> Remove
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {pendingCreation && (
        <div className="security-dialog-backdrop">
          <form className="security-dialog" onSubmit={createAccount} role="dialog" aria-modal="true" aria-labelledby="create-account-title">
            <div className="account-form-title">
              <span className="account-title-icon secure"><KeyRound size={19} /></span>
              <div>
                <p className="eyebrow">Security check</p>
                <h3 id="create-account-title">Confirm new Reviewer</h3>
                <p>Type the Admin password to create <strong>{form.username}</strong>.</p>
              </div>
            </div>
            {dialogError && <div className="notice error">{dialogError}</div>}
            <label>
              Admin password
              <input type="password" value={createPassword} onChange={(event) => setCreatePassword(event.target.value)} placeholder="Enter Admin password" autoComplete="current-password" autoFocus required />
            </label>
            <div className="button-row dialog-actions">
              <button type="button" className="ghost-btn" onClick={() => {
                setPendingCreation(false);
                setCreatePassword("");
                setDialogError("");
              }} disabled={busy}>Cancel</button>
              <button className="primary-btn" disabled={busy}>{busy ? "Creating..." : "Confirm and create"}</button>
            </div>
          </form>
        </div>
      )}

      {pendingRemoval && (
        <div className="security-dialog-backdrop">
          <form className="security-dialog" onSubmit={removeAccount} role="dialog" aria-modal="true" aria-labelledby="remove-account-title">
            <div className="account-form-title">
              <KeyRound size={20} />
              <div>
                <h3 id="remove-account-title">Remove {pendingRemoval.username}?</h3>
                <p>Type the Admin password to confirm.</p>
              </div>
            </div>
            {dialogError && <div className="notice error">{dialogError}</div>}
            <label>
              Admin password
              <input type="password" value={removePassword} onChange={(event) => setRemovePassword(event.target.value)} placeholder="Admin password" autoComplete="current-password" autoFocus required />
            </label>
            <div className="button-row dialog-actions">
              <button type="button" className="ghost-btn" onClick={() => {
                setPendingRemoval(null);
                setRemovePassword("");
                setDialogError("");
              }} disabled={busy}>Cancel</button>
              <button className="danger-btn" disabled={busy}>{busy ? "Removing..." : "Remove account"}</button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}

function CategoryManager({ categories, reload }) {
  const cloneField = (field) => ({
    ...field,
    options: [...(field.options || [])],
    autoDecision: {
      enabled: Boolean(field.autoDecision?.enabled),
      outcomes: { ...(field.autoDecision?.outcomes || {}) }
    }
  });
  const cloneCategory = (category) => ({
    id: category?.id || "",
    name: category?.name || "",
    detailFields: (category?.detailFields || []).map(cloneField),
    reviewQuestions: (category?.reviewQuestions || []).map(cloneField)
  });
  const [editingId, setEditingId] = useState(categories[0]?.id || "");
  const [builderMode, setBuilderMode] = useState("details");
  const [draft, setDraft] = useState(() => cloneCategory(categories[0]));
  const [activeField, setActiveField] = useState(0);
  const [message, setMessage] = useState(null);
  const [saving, setSaving] = useState(false);
  const collectionKey = builderMode === "details" ? "detailFields" : "reviewQuestions";
  const fields = draft[collectionKey] || [];
  const noun = builderMode === "details" ? "detail" : "question";

  useEffect(() => {
    const selected = categories.find((category) => category.id === editingId) || categories[0];
    if (!selected) return;
    setEditingId(selected.id);
    setDraft(cloneCategory(selected));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categories]);

  function selectCategory(category) {
    setEditingId(category.id);
    setDraft(cloneCategory(category));
    setActiveField(0);
    setMessage(null);
  }

  function setFields(updater) {
    setDraft((current) => ({ ...current, [collectionKey]: updater(current[collectionKey] || []) }));
  }

  function makeField() {
    return {
      id: `${builderMode === "details" ? "detail" : "question"}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      label: builderMode === "details" ? "Untitled detail" : "Untitled question",
      type: builderMode === "details" ? "text" : "radio",
      required: false,
      placeholder: "",
      options: builderMode === "details" ? [] : ["Option 1"],
      autoDecision: { enabled: false, outcomes: {} }
    };
  }

  function updateField(index, key, value) {
    setFields((current) => current.map((field, fieldIndex) => {
      if (fieldIndex !== index) return field;
      const next = { ...field, [key]: value };
      if (key === "type" && OPTION_QUESTION_TYPES.has(value) && !(field.options || []).length) next.options = ["Option 1"];
      if (key === "type") {
        next.autoDecision = AUTO_DECISION_QUESTION_TYPES.has(value)
          ? {
              enabled: Boolean(field.autoDecision?.enabled),
              outcomes: normalizedAutoOutcomes({ ...next, autoDecision: field.autoDecision })
            }
          : { enabled: false, outcomes: {} };
      }
      return next;
    }));
  }

  function toggleAutoDecision(index, enabled) {
    setFields((current) => current.map((field, fieldIndex) => {
      if (fieldIndex !== index) return field;
      return {
        ...field,
        required: enabled ? true : field.required,
        autoDecision: {
          enabled,
          outcomes: normalizedAutoOutcomes(field, enabled)
        }
      };
    }));
  }

  function updateAutoOutcome(fieldIndex, option, outcome) {
    setFields((current) => current.map((field, currentIndex) => currentIndex === fieldIndex
      ? {
          ...field,
          autoDecision: {
            enabled: true,
            outcomes: {
              ...(field.autoDecision?.outcomes || {}),
              [option]: outcome
            }
          }
        }
      : field));
  }

  function addField() {
    setActiveField(fields.length);
    setFields((current) => [...current, makeField()]);
  }

  function removeField(index) {
    setFields((current) => current.filter((_, fieldIndex) => fieldIndex !== index));
    setActiveField((current) => Math.max(0, Math.min(current, Math.max(0, fields.length - 2))));
  }

  function duplicateField(index) {
    setFields((current) => {
      const copy = {
        ...current[index],
        id: `${builderMode}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        options: [...(current[index].options || [])],
        autoDecision: {
          enabled: Boolean(current[index].autoDecision?.enabled),
          outcomes: { ...(current[index].autoDecision?.outcomes || {}) }
        }
      };
      const next = [...current];
      next.splice(index + 1, 0, copy);
      return next;
    });
    setActiveField(index + 1);
  }

  function moveField(index, direction) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= fields.length) return;
    setFields((current) => {
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
    setActiveField(nextIndex);
  }

  function updateOption(fieldIndex, optionIndex, value) {
    setFields((current) => current.map((field, currentIndex) => {
      if (currentIndex !== fieldIndex) return field;
      const previousOption = field.options?.[optionIndex] || "";
      const options = (field.options || []).map((option, currentOption) => currentOption === optionIndex ? value : option);
      const outcomes = { ...(field.autoDecision?.outcomes || {}) };
      if (previousOption !== value) {
        const previousOutcome = outcomes[previousOption] || "";
        delete outcomes[previousOption];
        if (value) outcomes[value] = previousOutcome;
      }
      return {
        ...field,
        options,
        autoDecision: {
          enabled: Boolean(field.autoDecision?.enabled),
          outcomes
        }
      };
    }));
  }

  function removeOption(fieldIndex, optionIndex) {
    setFields((current) => current.map((field, currentIndex) => {
      if (currentIndex !== fieldIndex) return field;
      const removedOption = field.options?.[optionIndex] || "";
      const outcomes = { ...(field.autoDecision?.outcomes || {}) };
      delete outcomes[removedOption];
      return {
        ...field,
        options: (field.options || []).filter((_, currentOption) => currentOption !== optionIndex),
        autoDecision: {
          enabled: Boolean(field.autoDecision?.enabled),
          outcomes
        }
      };
    }));
  }

  async function save(event) {
    event.preventDefault();
    setMessage(null);
    for (const key of ["detailFields", "reviewQuestions"]) {
      const blankIndex = (draft[key] || []).findIndex((field) => !field.label.trim());
      if (blankIndex !== -1) {
        setBuilderMode(key === "detailFields" ? "details" : "questions");
        setActiveField(blankIndex);
        setMessage({ type: "error", text: `${key === "detailFields" ? "Detail" : "Question"} ${blankIndex + 1} needs a title.` });
        return;
      }
      const missingOptions = (draft[key] || []).findIndex((field) => OPTION_QUESTION_TYPES.has(field.type) && !(field.options || []).some((option) => option.trim()));
      if (missingOptions !== -1) {
        setBuilderMode(key === "detailFields" ? "details" : "questions");
        setActiveField(missingOptions);
        setMessage({ type: "error", text: `${key === "detailFields" ? "Detail" : "Question"} ${missingOptions + 1} needs an option.` });
        return;
      }
      if (key === "reviewQuestions") {
        const invalidAutoIndex = (draft[key] || []).findIndex((field) => {
          if (!field.autoDecision?.enabled) return false;
          const options = questionAnswerOptions(field).map((option) => option.trim()).filter(Boolean);
          const outcomes = field.autoDecision?.outcomes || {};
          const mapped = options.map((option) => outcomes[option]);
          return !AUTO_DECISION_QUESTION_TYPES.has(field.type)
            || mapped.some((outcome) => !["approved", "rejected"].includes(outcome))
            || !mapped.includes("approved")
            || !mapped.includes("rejected");
        });
        if (invalidAutoIndex !== -1) {
          setBuilderMode("questions");
          setActiveField(invalidAutoIndex);
          setMessage({ type: "error", text: `Question ${invalidAutoIndex + 1} must map every answer and include both an approval and rejection result.` });
          return;
        }
      }
    }

    const payload = {
      ...draft,
      detailFields: draft.detailFields.map((field) => ({ ...field, options: (field.options || []).map((option) => option.trim()).filter(Boolean) })),
      reviewQuestions: draft.reviewQuestions.map((field) => {
        const options = (field.options || []).map((option) => option.trim()).filter(Boolean);
        return {
          ...field,
          required: field.autoDecision?.enabled ? true : field.required,
          options,
          autoDecision: {
            enabled: Boolean(field.autoDecision?.enabled),
            outcomes: field.autoDecision?.enabled
              ? Object.fromEntries(questionAnswerOptions({ ...field, options }).map((option) => [option, field.autoDecision?.outcomes?.[option] || ""]))
              : {}
          }
        };
      })
    };
    setSaving(true);
    try {
      const saved = await api.updateCategory(editingId, payload);
      setDraft(cloneCategory(saved));
      setMessage({ type: "success", text: `${saved.name} builder saved.` });
      await reload();
    } catch (saveError) {
      setMessage({ type: "error", text: saveError.message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="admin-section category-admin">
      <div className="section-head">
        <div>
          <p className="eyebrow">Admin only</p>
          <h2>Builder</h2>
        </div>
      </div>
      {message && <div className={cx("notice", message.type)}>{message.text}</div>}

      <div className="form-builder-shell">
        <div className="form-type-tabs" role="tablist" aria-label="Tool type">
          {categories.map((category) => (
            <button type="button" role="tab" aria-selected={editingId === category.id} key={category.id} className={cx(editingId === category.id && "active")} onClick={() => selectCategory(category)}>
              <span>{category.name}</span>
              <small>{(category.detailFields || []).length} details • {(category.reviewQuestions || []).length} questions</small>
            </button>
          ))}
        </div>

        <div className="builder-system-tabs">
          <button type="button" className={cx(builderMode === "details" && "active")} onClick={() => { setBuilderMode("details"); setActiveField(0); }}>
            <ClipboardList size={16} /> User Details
          </button>
          <button type="button" className={cx(builderMode === "questions" && "active")} onClick={() => { setBuilderMode("questions"); setActiveField(0); }}>
            <ListChecks size={16} /> Review Questions
          </button>
        </div>

        <form className="google-form-editor" onSubmit={save}>
          <div className="builder-context-line">
            <strong>{builderMode === "details" ? "Details completed by the User" : "Questions completed by the Reviewer or Admin"}</strong>
            <span>{fields.length} {fields.length === 1 ? noun : `${noun}s`}</span>
          </div>
          <div className="google-question-list">
            {fields.length === 0 && (
              <button type="button" className="empty-form-card" onClick={addField}>
                <Plus size={22} />
                <strong>Add the first {noun}</strong>
                <span>{builderMode === "details" ? "This tool type has no extra user details." : "This tool type has no review questions."}</span>
              </button>
            )}

            {fields.map((field, index) => (
              <article className={cx("google-question-card", activeField === index && "active")} key={field.id || `${noun}-${index}`} onClick={() => setActiveField(index)}>
                <div className="question-grip" aria-hidden="true"><GripVertical size={18} /></div>
                <div className="question-editor-row">
                  <div className="question-number">{index + 1}</div>
                  <input className="question-title-input" value={field.label} onFocus={() => setActiveField(index)} onChange={(event) => updateField(index, "label", event.target.value)} placeholder={builderMode === "details" ? "Detail label" : "Question"} />
                  <select className="question-type-select" value={field.type} onChange={(event) => updateField(index, "type", event.target.value)}>
                    {QUESTION_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
                  </select>
                </div>

                {OPTION_QUESTION_TYPES.has(field.type) && (
                  <div className="google-options-editor">
                    {(field.options || []).map((option, optionIndex) => (
                      <div className="google-option-row" key={`${field.id}-${optionIndex}`}>
                        <span className={field.type === "checkboxes" ? "option-shape square" : "option-shape"} />
                        <input value={option} onChange={(event) => updateOption(index, optionIndex, event.target.value)} placeholder={`Option ${optionIndex + 1}`} />
                        <button type="button" onClick={() => removeOption(index, optionIndex)} aria-label="Remove option"><XCircle size={17} /></button>
                      </div>
                    ))}
                    <button type="button" className="add-option-button" onClick={() => setFields((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, options: [...(entry.options || []), ""] } : entry))}>
                      <span className={field.type === "checkboxes" ? "option-shape square" : "option-shape"} /> Add option
                    </button>
                  </div>
                )}

                {field.type === "yesno" && <div className="question-preview-options"><span><i /> Yes</span><span><i /> No</span></div>}
                {["text", "textarea", "number", "date"].includes(field.type) && (
                  <div className={cx("answer-preview-line", field.type === "textarea" && "paragraph")}>
                    {field.type === "date" ? "Month, day, year" : field.type === "number" ? "Number answer" : field.type === "textarea" ? "Long-answer text" : "Short-answer text"}
                  </div>
                )}
                {field.type === "image" && <div className="image-answer-preview"><Camera size={18} /> Image upload</div>}

                {builderMode === "questions" && field.autoDecision?.enabled && (
                  <div className="auto-decision-editor">
                    <div>
                      <strong>Automatic result</strong>
                      <span>Each answer must approve or reject the request.</span>
                    </div>
                    <div className="auto-outcome-list">
                      {questionAnswerOptions(field).map((option) => (
                        <label key={`${field.id}-${option}`}>
                          <span>{option || "Unnamed option"}</span>
                          <select
                            value={field.autoDecision?.outcomes?.[option] || ""}
                            onChange={(event) => updateAutoOutcome(index, option, event.target.value)}
                          >
                            <option value="">Choose result</option>
                            <option value="approved">Auto approve</option>
                            <option value="rejected">Auto reject</option>
                          </select>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                <div className="google-question-footer">
                  <div className="question-move-actions">
                    <button type="button" disabled={index === 0} onClick={() => moveField(index, -1)}><ArrowUp size={17} /></button>
                    <button type="button" disabled={index === fields.length - 1} onClick={() => moveField(index, 1)}><ArrowDown size={17} /></button>
                  </div>
                  <div className="question-main-actions">
                    <button type="button" onClick={() => duplicateField(index)} title={`Duplicate ${noun}`}><Copy size={17} /></button>
                    <button type="button" onClick={() => removeField(index)} title={`Delete ${noun}`}><Trash2 size={17} /></button>
                    <span className="footer-divider" />
                    {builderMode === "questions" && AUTO_DECISION_QUESTION_TYPES.has(field.type) && (
                      <label className="required-switch auto-switch">
                        <span>Auto decision</span>
                        <input
                          type="checkbox"
                          checked={Boolean(field.autoDecision?.enabled)}
                          onChange={(event) => toggleAutoDecision(index, event.target.checked)}
                        />
                        <i />
                      </label>
                    )}
                    <label className="required-switch">
                      <span>Required</span>
                      <input type="checkbox" checked={Boolean(field.required)} onChange={(event) => updateField(index, "required", event.target.checked)} />
                      <i />
                    </label>
                  </div>
                </div>
              </article>
            ))}
          </div>
          <div className="form-builder-actions">
            <button type="button" className="secondary-btn" onClick={addField}><Plus size={16} /> Add {noun}</button>
            <button className="primary-btn" disabled={!editingId || saving}>{saving ? "Saving..." : "Save builder"}</button>
          </div>
        </form>
      </div>
    </section>
  );
}

function SearchBox({ value, onChange }) {
  return (
    <div className="admin-search-bar">
      <label className="search-field">
        <Search size={15} />
        <input value={value} onChange={(event) => onChange(event.target.value)} placeholder="Search Name or QR" aria-label="Search Name or QR" />
      </label>
    </div>
  );
}

function matchesSearch(record, search) {
  const query = search.trim().toLowerCase();
  if (!query) return true;
  return [
    record.itemName,
    record.itemCode,
    record.site,
    record.qrId,
    record.referenceId,
    record.categoryName,
    record.toolType
  ].some((value) => String(value || "").toLowerCase().includes(query));
}

function RequestCard({ request, openRequest }) {
  return (
    <button type="button" className={cx("record-button", "request-record", request.archivedAt ? "archived" : request.status)} onClick={() => openRequest(request.id)}>
      <span className="record-icon"><QrCode size={20} /></span>
      <span className="record-main">
        <small>{request.categoryName} • {request.site}</small>
        <strong>{request.itemName}</strong>
        <span>{request.referenceId}</span>
      </span>
      <StatusBadge status={request.archivedAt ? "archived" : request.status} />
      <span className="record-date">{request.status === "pending" ? "Submitted" : "Reviewed"}<strong>{formatDate(request.status === "pending" ? request.submittedAt : request.reviewedAt)}</strong></span>
      <span className="record-view"><Eye size={15} /> Open details</span>
    </button>
  );
}

function ItemCard({ item, openItem }) {
  return (
    <button type="button" className={cx("record-button", "item-record", item.validity?.status)} onClick={() => openItem(item.qrId)}>
      <img src={item.qrImageDataUrl} alt="" className="qr-thumb" />
      <span className="record-main">
        <small>{item.toolType || item.categoryName} • {item.site}</small>
        <strong>{item.itemName}</strong>
        <span>QR: {item.qrId}</span>
      </span>
      <StatusBadge validity={item.validity} />
      <span className="record-date">Next check<strong>{formatDate(item.expiresAt)}</strong></span>
      <span className="record-view"><Eye size={15} /> Open details</span>
    </button>
  );
}

function RecordsPanel({ title, records, kind, openItem, openRequest, emptyMessage }) {
  const [search, setSearch] = useState("");
  const visible = records.filter((record) => matchesSearch(record, search));
  return (
    <section className="admin-section">
      <div className="records-toolbar">
        <div className="records-title">
          <div><p className="eyebrow">Power Tool</p><h2>{title}</h2></div>
          <span className="quick-count"><strong>{visible.length}</strong><small>entries</small></span>
        </div>
        <SearchBox value={search} onChange={setSearch} />
      </div>
      {visible.length === 0 ? (
        <EmptyState icon={kind === "request" ? ClipboardList : QrCode} title={`No ${title.toLowerCase()}`} message={emptyMessage} />
      ) : (
        <div className={kind === "request" ? "request-list" : "asset-list"}>
          {visible.map((record) => kind === "request"
            ? <RequestCard key={record.id} request={record} openRequest={openRequest} />
            : <ItemCard key={record.id} item={record} openItem={openItem} />)}
        </div>
      )}
    </section>
  );
}

function ArchivedPanel({ requests, items, openItem, openRequest }) {
  const [search, setSearch] = useState("");
  const archivedRequests = requests.filter((request) => request.archivedAt && matchesSearch(request, search));
  const archivedItems = items.filter((item) => item.archivedAt && matchesSearch(item, search));
  return (
    <section className="admin-section">
      <div className="records-toolbar">
        <div className="records-title">
          <div><p className="eyebrow">Power Tool</p><h2>Archived</h2></div>
          <span className="quick-count"><strong>{archivedRequests.length + archivedItems.length}</strong><small>entries</small></span>
        </div>
        <SearchBox value={search} onChange={setSearch} />
      </div>
      {archivedRequests.length + archivedItems.length === 0 ? (
        <EmptyState icon={Archive} title="No archived records" message="Archived Approved, Rejected, and Expired records appear here." />
      ) : (
        <div className="archive-groups">
          {archivedItems.length > 0 && <div className="asset-list">{archivedItems.map((item) => <ItemCard key={item.id} item={item} openItem={openItem} />)}</div>}
          {archivedRequests.length > 0 && <div className="request-list">{archivedRequests.map((request) => <RequestCard key={request.id} request={request} openRequest={openRequest} />)}</div>}
        </div>
      )}
    </section>
  );
}

function StaffDashboard({ staffSession, categories, requests, allItems, reloadAll, openItem, openRequest }) {
  const role = staffSession.role;
  const allowedPanels = role === "admin"
    ? ["builder", "accounts", "requests", "approved", "rejected", "expired", "archived"]
    : ["requests", "approved", "rejected", "expired", "archived"];
  const storageKey = `power-tool-${role}-panel`;
  const [activePanel, setActivePanel] = useState(() => {
    const saved = localStorage.getItem(storageKey);
    return allowedPanels.includes(saved) ? saved : "requests";
  });
  const pending = requests.filter((request) => request.status === "pending" && !request.archivedAt);
  const rejected = requests.filter((request) => request.status === "rejected" && !request.archivedAt);
  const approved = allItems.filter((item) => !item.archivedAt && item.validity?.status === "valid");
  const expired = allItems.filter((item) => !item.archivedAt && item.validity?.status === "expired");
  const archivedCount = requests.filter((request) => request.archivedAt).length + allItems.filter((item) => item.archivedAt).length;

  useEffect(() => {
    localStorage.setItem(storageKey, activePanel);
  }, [activePanel, storageKey]);

  return (
    <main className="admin-page compact-admin staff-dashboard">
      <div className={cx("stats-grid", "admin-nav-grid", role === "reviewer" && "reviewer-nav-grid")}>
        {role === "admin" && <StatCard icon={Plus} label="Builder" value="Details + Questions" active={activePanel === "builder"} onClick={() => setActivePanel("builder")} />}
        {role === "admin" && <StatCard icon={UserPlus} label="Accounts" value="Reviewers" active={activePanel === "accounts"} onClick={() => setActivePanel("accounts")} />}
        <StatCard icon={Bell} label="Requests" value={pending.length} tone="warn" active={activePanel === "requests"} onClick={() => setActivePanel("requests")} badge={pending.length} />
        <StatCard icon={CheckCircle2} label="Approved" value={approved.length} tone="ok" active={activePanel === "approved"} onClick={() => setActivePanel("approved")} />
        <StatCard icon={XCircle} label="Rejected" value={rejected.length} tone="danger" active={activePanel === "rejected"} onClick={() => setActivePanel("rejected")} />
        <StatCard icon={CalendarDays} label="Expired" value={expired.length} tone="danger" active={activePanel === "expired"} onClick={() => setActivePanel("expired")} />
        <StatCard icon={Archive} label="Archived" value={archivedCount} active={activePanel === "archived"} onClick={() => setActivePanel("archived")} />
      </div>

      <div className="admin-panel-slot">
        {activePanel === "builder" && role === "admin" && <CategoryManager categories={categories} reload={reloadAll} />}
        {activePanel === "accounts" && role === "admin" && <ReviewerAccounts adminSession={staffSession} />}
        {activePanel === "requests" && <RecordsPanel title="Requests" records={pending} kind="request" openRequest={openRequest} emptyMessage="New User submissions appear here." />}
        {activePanel === "approved" && <RecordsPanel title="Approved" records={approved} kind="item" openItem={openItem} emptyMessage="Approved tools with a good QR appear here." />}
        {activePanel === "rejected" && <RecordsPanel title="Rejected" records={rejected} kind="request" openRequest={openRequest} emptyMessage="Rejected requests appear here." />}
        {activePanel === "expired" && <RecordsPanel title="Expired" records={expired} kind="item" openItem={openItem} emptyMessage="Expired QR records appear here." />}
        {activePanel === "archived" && <ArchivedPanel requests={requests} items={allItems} openItem={openItem} openRequest={openRequest} />}
      </div>
    </main>
  );
}

export default function App() {
  const routeRecord = useMemo(() => {
    const parts = window.location.pathname.split("/").filter(Boolean);
    if (parts[0] === "item" && parts[1]) return { kind: "item", id: decodeURIComponent(parts[1]) };
    if (parts[0] === "request" && parts[1]) return { kind: "request", id: decodeURIComponent(parts[1]) };
    return { kind: "", id: "" };
  }, []);

  const storedMainTab = localStorage.getItem("qr-active-tab") || "user";
  const savedMainTab = storedMainTab === "admin"
    ? "reviewer"
    : (["user", "reviewer"].includes(storedMainTab) ? storedMainTab : "user");
  const [tab, setTab] = useState(routeRecord.id ? "details" : savedMainTab);
  const [detailsReturn, setDetailsReturn] = useState({ tab: savedMainTab, userMode: "followup" });
  const [userMode, setUserMode] = useState("home");
  const [selectedRecord, setSelectedRecord] = useState(routeRecord);
  const [categories, setCategories] = useState([]);
  const [requests, setRequests] = useState([]);
  const [allItems, setAllItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [theme, setTheme] = useState(() => localStorage.getItem("qr-theme") || "light");
  const [staffSession, setStaffSession] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STAFF_SESSION_KEY) || "null");
      return saved?.role === "reviewer" ? saved : null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("qr-theme", theme);
  }, [theme]);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STAFF_SESSION_KEY) || "null");
      if (saved?.role === "admin") localStorage.removeItem(STAFF_SESSION_KEY);
    } catch {
      localStorage.removeItem(STAFF_SESSION_KEY);
    }
  }, []);

  async function loadCategories() {
    const data = await api.categories();
    setCategories(data);
  }

  async function loadRequests() {
    const data = await api.requests();
    setRequests(data);
  }

  async function loadItems() {
    setAllItems(await api.items({ sort: "expiry", includeArchived: true }));
  }

  async function reloadAll({ silent = false } = {}) {
    if (!silent) setLoadError("");
    try {
      await Promise.all([loadCategories(), loadRequests(), loadItems()]);
    } catch (error) {
      if (!silent) setLoadError(error.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const sessionId = getVisitSessionId();
    const visitorIdentity = staffSession
      ? {
          accountUsername: staffSession.username,
          accountRole: staffSession.role
        }
      : {};
    const trackSession = () => api.trackVisit({
      sessionId,
      path: window.location.pathname,
      ...visitorIdentity
    }).catch(() => null);
    const handleVisibility = () => {
      if (document.visibilityState === "visible") trackSession();
    };
    const handlePageHide = () => {
      api.endVisit({
        sessionId,
        path: window.location.pathname
      });
    };

    trackSession();
    const heartbeat = window.setInterval(() => {
      if (document.visibilityState === "visible") trackSession();
    }, VISIT_HEARTBEAT_MS);
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pagehide", handlePageHide);

    return () => {
      window.clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pagehide", handlePageHide);
    };
  }, [staffSession?.role, staffSession?.username]);

  useEffect(() => {
    reloadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openItem(qrId, keepReturn = false) {
    const finalQrId = parseQrText(qrId);
    if (!keepReturn) {
      setDetailsReturn({ tab: tab === "reviewer" ? "reviewer" : "user", userMode: userMode || "followup" });
    }
    setSelectedRecord({ kind: "item", id: finalQrId });
    setTab("details");
    if (window.location.pathname !== `/item/${finalQrId}`) {
      window.history.pushState({}, "", `/item/${finalQrId}`);
    }
  }

  function openRequest(requestId) {
    setDetailsReturn({ tab: staffSession ? "reviewer" : "user", userMode: userMode || "followup" });
    setSelectedRecord({ kind: "request", id: requestId });
    setTab("details");
    if (window.location.pathname !== `/request/${requestId}`) {
      window.history.pushState({}, "", `/request/${requestId}`);
    }
  }

  function setMainTab(nextTab) {
    const finalTab = nextTab === "admin" ? "reviewer" : nextTab;
    if (finalTab !== "reviewer" && staffSession?.role === "admin") logoutStaff();
    setTab(finalTab);
    localStorage.setItem("qr-active-tab", finalTab);
    if (finalTab === "user") setUserMode("home");
    if (finalTab !== "details" && (window.location.pathname.startsWith("/item/") || window.location.pathname.startsWith("/request/"))) {
      window.history.pushState({}, "", "/");
    }
  }

  function backFromDetails() {
    if (window.location.pathname.startsWith("/item/") || window.location.pathname.startsWith("/request/")) {
      window.history.pushState({}, "", "/");
    }
    if (detailsReturn.tab === "reviewer") {
      setTab("reviewer");
      localStorage.setItem("qr-active-tab", "reviewer");
      return;
    }
    setUserMode(detailsReturn.userMode || "followup");
    setTab("user");
    localStorage.setItem("qr-active-tab", "user");
  }

  const activeMainTab = tab === "details"
    ? (detailsReturn.tab === "admin" ? "reviewer" : detailsReturn.tab)
    : tab;
  const pendingRequestCount = requests.filter((entry) => entry.status === "pending" && !entry.archivedAt).length;

  function loginStaff(session) {
    if (session.role === "reviewer") {
      localStorage.setItem(STAFF_SESSION_KEY, JSON.stringify(session));
    } else {
      localStorage.removeItem(STAFF_SESSION_KEY);
    }
    setStaffSession(session);
  }

  function logoutStaff() {
    api.trackSessionLogout({
      sessionId: getVisitSessionId(),
      path: window.location.pathname
    }).catch(() => null);
    localStorage.removeItem(STAFF_SESSION_KEY);
    setStaffSession(null);
  }

  return (
    <div className="app-shell" data-developer-credit={DEVELOPER_CREDIT}>
      <header className="topbar">
        <button className="brand" onClick={() => setMainTab("user")}>
          <span><ShieldCheck size={20} /></span>
          <strong>Power Tool</strong>
        </button>

        <div className="topbar-actions">
          <nav>
            <button className={cx(activeMainTab === "user" && "active")} onClick={() => setMainTab("user")}><UserCircle size={16} /> User</button>
            <button className={cx(activeMainTab === "reviewer" && "active", "nav-with-badge", "desktop-reviewer-toggle")} onClick={() => setMainTab("reviewer")}>
              <ListChecks size={16} /> Reviewer
              {staffSession && pendingRequestCount > 0 && <span className="nav-badge">{pendingRequestCount}</span>}
            </button>
            <button
              type="button"
              className={cx(activeMainTab === "reviewer" && "active", "mobile-reviewer-toggle")}
              onClick={() => staffSession ? logoutStaff() : setMainTab("reviewer")}
              aria-label={staffSession ? "Log out" : "Open Reviewer login"}
            >
              {staffSession ? <LogOut size={16} /> : <ListChecks size={16} />}
              {staffSession ? "Log out" : "Reviewer"}
            </button>
          </nav>
          {staffSession && (
            <div className="topbar-session">
              <span className={cx("topbar-session-icon", staffSession.role)}>
                {staffSession.role === "admin" ? <ShieldCheck size={15} /> : <ListChecks size={15} />}
              </span>
              <span className="topbar-session-copy">
                <strong>{staffSession.username}</strong>
                <small>{staffSession.role === "admin" ? "Admin" : "Reviewer"}</small>
              </span>
              <button type="button" onClick={logoutStaff} aria-label="Sign out" title="Sign out">
                <LogOut size={15} />
              </button>
            </div>
          )}
          <button className="top-action icon-only" onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")} aria-label="Toggle light and dark mode">
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
      </header>

      {loadError && <div className="global-error">{loadError}</div>}
      {loading && <div className="loading-strip"><RefreshCw size={15} /> Loading Power Tool...</div>}

      <div className="view-area">
        {tab === "user" && userMode === "home" && <UserHome onPick={setUserMode} />}
        {tab === "user" && userMode === "register" && <UserRegister categories={categories} onCreated={reloadAll} onBack={() => setUserMode("home")} />}
        {tab === "user" && userMode === "followup" && <ScanPage onOpenItem={openItem} onBack={() => setUserMode("home")} />}
        {tab === "reviewer" && !staffSession && <StaffLogin onLogin={loginStaff} />}
        {tab === "reviewer" && staffSession && <StaffDashboard staffSession={staffSession} categories={categories} requests={requests} allItems={allItems} reloadAll={reloadAll} openItem={openItem} openRequest={openRequest} />}
        {tab === "details" && selectedRecord.kind === "item" && (
          <ItemDetails qrId={selectedRecord.id} onBack={backFromDetails} staffSession={staffSession} reload={reloadAll} />
        )}
        {tab === "details" && selectedRecord.kind === "request" && (
          <RequestDetails
            requestId={selectedRecord.id}
            onBack={backFromDetails}
            onApproved={(qrId) => openItem(qrId, true)}
            staffSession={staffSession}
            reload={reloadAll}
          />
        )}
      </div>
    </div>
  );
}
