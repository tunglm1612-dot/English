# Vocab Together - Full Oxford 3000 + Oxford 5000 (Netlify + Supabase)

Website hoc tu vung nhieu nguoi dung, co flashcard, bai tap, lich su hoc, Reading va trang Admin.

## Du lieu tu vung trong ban nay

Ban nay da gom hai tai lieu nguon:

- **The Oxford 3000**: cac tu A1-B2.
- **The Oxford 5000 additional list**: cac tu bo sung B2-C1.

File `site/data/words.json` co **5.323 muc tu hoc**, sap xep theo alphabet. So luong theo muc trinh do:

- A1: 900
- A2: 872
- B1: 809
- B2: 1427
- C1: 1315

So muc hoc co the lon hon 5.000 vi mot headword co the co nhieu tu loai hoac cap do khac nhau, vi du mot tu vua la danh tu vua la dong tu. Chi muc trung hoan toan (cung tu, tu loai, cap do va goi y nghia) moi bi loai.

## Cac sua loi va tinh nang

- Ho tro bo loc va noi dung A1, A2, B1, B2, C1; van co san C2/Custom de ban tu them.
- Bai **Dien chu** hien nghia tieng Viet, tu loai va trinh do truoc khi nguoi hoc dien tu tieng Anh.
- Bai Reading hien diem va dap an dung/sai sau khi nop; co nut lam lai.
- Flashcard tu dong tai nghia tieng Viet neu tu chua co nghia.
- Admin co nut **Tu dong dien nghia con thieu** de luu nghia vao database dung chung.
- Admin co the them tu moi, upload CSV va dang bai Reading theo trinh do.

## Luu y quan trong ve `site/config.js`

File trong goi tai xuong dang de placeholder Supabase. Neu website hien tai cua ban da ket noi Supabase, **giu lai file `site/config.js` dang dung tren may ban**, hoac dien lai `SUPABASE_URL` va `SUPABASE_ANON_KEY` truoc khi push.

Khong dua `service_role` hoac secret key vao website.

## Cap nhat vao repository GitHub dang dung

1. Giai nen file ZIP nay.
2. Copy tat ca file/thu muc vao thu muc repository cu cua ban.
3. Khi copy, giu lai `site/config.js` cu da dien Supabase key (hoac dien lai sau khi copy).
4. Mo PowerShell tai thu muc repository va chay:

```powershell
git add .
git commit -m "Add full Oxford 3000 and 5000 vocabulary with exercise fixes"
git push origin main
```

5. Cho Netlify deploy xong, mo web va bam `Ctrl + F5`.

## Cap nhat database sau khi web da deploy

Dang nhap bang tai khoan Admin, vao **Admin** va bam:

1. **Nhap/cap nhat kho Oxford day du** - nap them tu A1-B2 va giu cac tu B2-C1 cu theo khoa on dinh, khong nhan doi cac dong da nhap tu ban cu.
2. **Tu dong dien nghia con thieu** - website se dich va luu nghia tieng Viet vao Supabase. Qua trinh voi hang nghin muc tu co the mat thoi gian; neu bi dung, bam lai de tiep tuc phan con thieu.

## Cau truc deploy

- `site/`: website tinh.
- `site/data/words.json`: kho tu seed.
- `netlify/functions/translate.mjs`: function dich nghia tu dong.
- `supabase/schema.sql`: schema database da su dung tu ban truoc.
- `netlify.toml`: cau hinh publish va functions.
