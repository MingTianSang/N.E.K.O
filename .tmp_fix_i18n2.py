import json
import os

# Add saveMasterSuccess to all 8 locale files
save_master_success = {
    'zh-CN': '保存主人设定成功',
    'en': 'Master profile saved successfully',
    'ja': 'マスタープロフィールを保存しました',
    'ko': '주인 설정 저장 성공',
    'ru': 'Профиль мастера сохранен',
    'zh-TW': '儲存主人設定成功',
    'es': 'Perfil de maestro guardado correctamente',
    'pt': 'Perfil do mestre salvo com sucesso',
}

for lang, val in save_master_success.items():
    path = f'static/locales/{lang}.json'
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    data['character']['saveMasterSuccess'] = val
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=4)
        f.write('\n')
    print(f'Added saveMasterSuccess to {lang}.json')

# Fix test script filter logic
test_path = 'tests/unit/test_cloudsave_i18n.py'
with open(test_path, 'r', encoding='utf-8') as f:
    content = f.read()

old_func = '''def _extract_i18n_keys() -> set[str]:
    keys: set[str] = set()
    pattern = re.compile(r"(cloudsave\\.[A-Za-z0-9_.]+|character\\.[A-Za-z0-9_.]+)")
    for path in (CLOUDSAVE_JS, CLOUDSAVE_TEMPLATE, CHARA_TEMPLATE, CHARA_MANAGER_JS):
        keys.update(pattern.findall(path.read_text(encoding="utf-8")))
    return keys'''

new_func = '''def _extract_i18n_keys() -> set[str]:
    keys: set[str] = set()
    pattern = re.compile(r"(cloudsave\\.[A-Za-z0-9_.]+|character\\.[A-Za-z0-9_.]+)")
    for path in (CLOUDSAVE_JS, CLOUDSAVE_TEMPLATE, CHARA_TEMPLATE, CHARA_MANAGER_JS):
        keys.update(pattern.findall(path.read_text(encoding="utf-8")))
    # 过滤掉以点结尾的动态键前缀（如 'character.field.' + key）
    keys = {k for k in keys if not k.endswith('.')}
    return keys'''

if old_func in content:
    content = content.replace(old_func, new_func)
    with open(test_path, 'w', encoding='utf-8') as f:
        f.write(content)
    print('Fixed test script filter logic')
else:
    print('WARNING: Could not find expected function in test script')
