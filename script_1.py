import os
import requests
from bs4 import BeautifulSoup
import time

# Thay thế bằng thông tin của bạn
WEBHOOK_URL = "https://discord.com/api/webhooks/1338054849480097812/wKQXzY6RCa0K3AHKxE-5Ani1kevul9k2ILWKw4OWIXtDFDgagzaur9w-O5EihodIq21a"

# URL trang web
URL = 'https://kodoani.com/'

# Tập hợp để lưu trữ các bài viết đã gửi
sent_posts = set()

def fetch_latest_news():
    # print("Fetching latest news...")  # Bỏ comment dòng này nếu không cần in ra
    try:
        response = requests.get(URL)
        response.raise_for_status()  # Raises HTTPError for bad requests (4xx or 5xx)
    except requests.exceptions.RequestException as e:
        print(f"Error fetching news: {e}")
        return []

    soup = BeautifulSoup(response.text, 'html.parser')
    posts = soup.find_all('div', class_='col-sm-3 menu-post-item')
    latest_posts = []

    for post in posts:
        time_span = post.find('span')
        if time_span:
            time_text = time_span.get_text().strip()
            # Thay đổi phần kiểm tra thời gian ở đây
            if 'giây' in time_text:
                seconds_ago = int(time_text.split()[0])
                # if seconds_ago <= 1: # Không cần check <=1 nữa, vì đã check 'giây' rồi
                title = post.find('img')['alt']
                link = post.find('a')['href']

                # Lấy ảnh thumbnail từ trang bài viết
                try:
                    article_response = requests.get(link)
                    article_response.raise_for_status()
                    article_soup = BeautifulSoup(article_response.text, 'html.parser')
                    og_image = article_soup.find('meta', property='og:image')
                    image_url = og_image['content'] if og_image else ''
                except requests.exceptions.RequestException as e:
                    print(f"Error fetching article details: {e}")
                    image_url = ''  # Set a default or placeholder image


                latest_posts.append({
                    'title': title,
                    'image_url': image_url,
                    'link': link
                })

    # print(f"Found {len(latest_posts)} new posts") # Bỏ comment dòng này nếu không cần
    return latest_posts

def send_to_discord_via_webhook(posts):
    for post in posts:
        if post['link'] not in sent_posts:
            # print(f"Processing post: {post['title']}") # Bỏ comment dòng này
            data = {
                "embeds": [
                    {
                        "title": post['title'],
                        "url": post['link'],
                        "color": 5814783,
                        "image": {"url": post['image_url']}
                    }
                ]
            }

            # Gửi tin qua webhook
            # print("Sending message to webhook...")  # Bỏ comment dòng này
            try:
                result = requests.post(WEBHOOK_URL, json=data)
                result.raise_for_status()
                # print(f'Webhook response: {result.text}') # Bỏ comment dòng này
                # print(f'Webhook status code: {result.status_code}') # Bỏ comment
            except requests.exceptions.RequestException as e:
                print(f"Error sending to webhook: {e}")


            sent_posts.add(post['link'])

def main():
    while True:
        latest_posts = fetch_latest_news()
        if latest_posts:
            send_to_discord_via_webhook(latest_posts)
        time.sleep(1)  # Chờ 1 giây

if __name__ == "__main__":
    main()
