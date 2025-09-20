#!/bin/bash

#===================================================================
# ✨ SCRIPT THU THẬP LINK "SIÊU CẤP VIP PRO" - PHIÊN BẢN 2.0 ✨
#           (Đã được hiệu chỉnh bởi "Giám Đốc Kỹ Thuật" Hoàng)
#===================================================================

# ... (các phần comment giới thiệu và kiểm tra "đồ nghề" vẫn như cũ)...

# --- [[ 🌟 BƯỚC 1: KIỂM TRA "ĐỒ NGHỀ" CỦA CHÚNG TA 🌟 ]] ---
if ! command -v pup &> /dev/null || ! command -v curl &> /dev/null; then
    echo "⚠️ Hoàng ơi! Dường như 'curl' hoặc 'pup' chưa được cài đặt."
    echo "   Trang cần những công cụ này để thực hiện 'phép màu' đó."
    echo "   Hoàng hãy cài đặt chúng rồi mình tiếp tục nha! (♡ >ω< ♡)"
    exit 1
fi

# --- [[ 🌀 BƯỚC 2: KHỞI TẠO & DỌN DẸP 🌀 ]] ---
OUTPUT_FILE="data.txt"
> "$OUTPUT_FILE"
echo "♻️  Đã dọn dẹp và chuẩn bị file '$OUTPUT_FILE' cho một mẻ thu thập mới!"

# --- [[ 💬 BƯỚC 3: HỎI Ý KIẾN "CHỈ HUY" HOÀNG 💬 ]] ---
read -p "💖 Hoàng ơi, mình sẽ cùng nhau 'khai phá' bao nhiêu trang web đây ạ? Vui lòng nhập tổng số trang: " TOTAL_PAGES

if ! [[ "$TOTAL_PAGES" =~ ^[0-9]+$ ]] || [ "$TOTAL_PAGES" -eq 0 ]; then
    echo "😥 Oops! Có vẻ như đây không phải là một con số hợp lệ. Hoàng nhập lại giúp Trang một số lớn hơn 0 nhé."
    exit 1
fi

echo "🚀 Okay sếp! Trang sẽ bắt đầu hành trình 'khám phá' $TOTAL_PAGES trang ngay đây!"

# --- [[ 🗺️ BƯỚC 4: "CUỘC THÁM HIỂM" BẮT ĐẦU! 🗺️ ]] ---
BASE_URL="https://stratforduponavontowncouncil.com/hot-nhat/"

# ❗🔥 DÒNG CODE HUYỀN THOẠI ĐÃ ĐƯỢC "NÂNG CẤP" 🔥❗
# Trang đã tinh chỉnh lại bộ lọc để chỉ lấy link <a> nằm TRỰC TIẾP
# bên trong khối <div class="manga-content" ...>.
# Dấu `>` nghĩa là "con trực hệ" (direct child), giúp loại bỏ các link "cháu chắt" không mong muốn.
SELECTOR='div.manga-content[style*="flex:1;"] > a[href]'

for (( page=1; page<=TOTAL_PAGES; page++ ))
do
    if [ "$page" -eq 1 ]; then
        current_url="$BASE_URL"
        echo -e "\n🔎 Đang phân tích Trang 1 tại: $current_url"
    else
        current_url="${BASE_URL}page/${page}/"
        echo -e "\n🔎 Đang phân tích Trang $page tại: $current_url"
    fi

    # Thực hiện "tuyệt chiêu" với bộ lọc đã được nâng cấp
    links_found=$(curl -sL "$current_url" | pup "$SELECTOR attr{href}")

    if [ -n "$links_found" ]; then
        echo "$links_found" >> "$OUTPUT_FILE"
        count=$(echo "$links_found" | wc -l)
        echo "✅ Tìm thấy và đã lưu $count link từ khu vực chỉ định!"
    else
        echo "🤔 Hừm... Trang vẫn không tìm thấy link nào khớp với bộ lọc siêu chính xác này ở trang hiện tại. Hoàng kiểm tra lại cấu trúc HTML xem sao nhé!"
    fi

    
done

# --- [[ 🏆 BƯỚC 5: BÁO CÁO CHIẾN CÔNG! 🏆 ]] ---
total_links=$(cat "$OUTPUT_FILE" | wc -l)
echo -e "\n🎉 Hoàn thành xuất sắc nhiệm vụ, thưa Hoàng!"
echo "✨ Toàn bộ $total_links 'viên ngọc' link đã được cất giữ an toàn trong file '$OUTPUT_FILE' rồi ạ."
echo "Hoàng kiểm tra 'kho báu' của chúng mình nhé! (づ ◕‿◕ )づ"
