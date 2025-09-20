#!/usr/bin/env bash


set -euo pipefail
IFS=$'\n\t'

INPUT_FILE="data.txt"
OUTPUT_FILE="output.csv"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# Chọn engine phân tích HTML: pup ưu tiên, fallback sang htmlq
ENGINE=""
if command -v pup >/dev/null 2>&1; then
  ENGINE="pup"
elif command -v htmlq >/dev/null 2>&1; then
  ENGINE="htmlq"
else
  echo "Lỗi: Cần cài đặt 'pup' (khuyến nghị) hoặc 'htmlq'." >&2
  exit 1
fi

# Hàm thoát CSV an toàn
csv_escape() {
  # Thay " -> "" và thay xuống dòng bằng khoảng trắng
  local s=${1//$'\r'/ }
  s=${s//$'\n'/ }
  s=${s//\"/\"\"}
  printf '"%s"' "$s"
}

# Helpers theo engine
get_text() {
  # $1: selector, $2: file
  if [[ $ENGINE == "pup" ]]; then
    pup -f "$2" "$1 text{}" 2>/dev/null || true
  else
    htmlq -f "$2" --text "$1" 2>/dev/null || true
  fi
}

get_attr() {
  # $1: selector, $2: attr, $3: file
  if [[ $ENGINE == "pup" ]]; then
    pup -f "$3" "$1 attr{$2}" 2>/dev/null || true
  else
    htmlq -f "$3" --attribute "$2" "$1" 2>/dev/null || true
  fi
}

# Ghi header CSV
echo 'name,img,category,status' > "$OUTPUT_FILE"

# Đọc từng URL
while IFS= read -r url || [[ -n "${url}" ]]; do
  # Bỏ qua dòng trống hoặc comment
  [[ -z "${url// }" ]] && continue
  [[ "${url}" =~ ^# ]] && continue

  pagefile="$TMPDIR/page.html"

  # Tải trang (theo dõi redirect, đặt user-agent)
  if ! curl -fsSL -A "Mozilla/5.0 (X11; Linux x86_64) BashScraper/1.0" "$url" -o "$pagefile"; then
    echo "Cảnh báo: tải thất bại $url" >&2
    continue
  fi

  # 1) name: <h1 class="tieu-de-truyen">…</h1>
  name_raw="$(get_text 'h1.tieu-de-truyen' "$pagefile" | head -n1)"
  name="$(echo "$name_raw" | sed 's/[[:space:]]\+/ /g' | sed 's/^[[:space:]]\+//; s/[[:space:]]\+$//')"

  # 2) img: trong <div class="thumb-bg"> ... <img data-src="...">
  img="$(get_attr 'div.thumb-bg img' 'data-src' "$pagefile" | head -n1)"
  # Fallback nếu data-src trống thì thử src
  if [[ -z "${img}" ]]; then
    img="$(get_attr 'div.thumb-bg img' 'src' "$pagefile" | head -n1)"
  fi

  # 3) category: trong <div class="info-genre">… <img alt="...">
  # Có thể có nhiều <img>; nối bằng |
  mapfile -t cat_arr < <(get_attr 'div.info-genre img' 'alt' "$pagefile" | sed '/^[[:space:]]*$/d')
  if (( ${#cat_arr[@]} == 0 )); then
    # fallback: nếu có text trực tiếp (trường hợp site không dùng img cho thể loại)
    cat_txt="$(get_text 'div.info-genre' "$pagefile" | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g')"
    category="$cat_txt"
  else
    category="$(printf "%s\n" "${cat_arr[@]}" | paste -sd '|' -)"
  fi

  # 4) status: chỉ lấy văn bản của mỗi thẻ div con trực tiếp của .info-status
  # Lấy các div con trực tiếp, gom text từng div và nối bằng " | "
  if [[ $ENGINE == "pup" ]]; then
    # Lấy HTML mỗi div con, tước tag để chỉ còn text (bỏ nội dung thẻ con)
    # pup không hỗ trợ "own text" nên tước tag bằng sed
    mapfile -t stat_divs < <(pup -f "$pagefile" 'div.info-status > div' 2>/dev/null || true)
    status_pieces=()
    if (( ${#stat_divs[@]} > 0 )); then
      # Pup xuất HTML các khối; gom lại theo khối bằng dấu trống
      # Chia khối bằng </div> (đơn giản hoá)
      IFS=$'\n' read -r -d '' -a chunks < <(pup -f "$pagefile" 'div.info-status > div' 2>/dev/null | awk '1; END{print ""}' RS="</div>" ORS='\0')
      for chunk in "${chunks[@]}"; do
        txt="$(echo "$chunk" | sed 's/<[^>]*>/ /g' | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g; s/^[[:space:]]\+//; s/[[:space:]]\+$//')"
        [[ -n "$txt" ]] && status_pieces+=("$txt")
      done
      status="$(printf "%s\n" "${status_pieces[@]}" | paste -sd ' | ' -)"
    else
      # fallback: lấy toàn bộ text
      status="$(get_text 'div.info-status' "$pagefile" | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g')"
    fi
  else
    # htmlq: không có "own text", nên tước tag thủ công trên HTML mỗi div con
    htmlq -f "$pagefile" 'div.info-status > div' --pretty 2>/dev/null | awk '
      BEGIN{RS="</div>"; ORS="\n"}
      {print}
    ' | while IFS= read -r block; do
      t="$(echo "$block" | sed 's/<[^>]*>/ /g' | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g; s/^[[:space:]]\+//; s/[[:space:]]\+$//')"
      [[ -n "$t" ]] && echo "$t"
    done > "$TMPDIR/status.txt"
    if [[ -s "$TMPDIR/status.txt" ]]; then
      status="$(paste -sd ' | ' "$TMPDIR/status.txt")"
    else
      status="$(get_text 'div.info-status' "$pagefile" | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g')"
    fi
  fi

  # Ghi vào CSV
  {
    csv_escape "$name"; printf ","
    csv_escape "$img"; printf ","
    csv_escape "$category"; printf ","
    csv_escape "$status"; printf "\n"
  } >> "$OUTPUT_FILE"

  echo "✔ Done: $url"
done < "$INPUT_FILE"

echo "Hoàn tất. Kết quả: $OUTPUT_FILE"
