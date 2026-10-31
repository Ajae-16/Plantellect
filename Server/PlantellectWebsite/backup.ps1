# ---- set this ----
$DatasetIndex = "D:\path\to\datasets\index"   # folder containing config.json, splits.json, groups_manual.csv
# ------------------

$d   = Get-Date -Format "yyyy-MM-dd_HHmm"
$dir = ".\backups\$d"
New-Item -ItemType Directory -Force $dir | Out-Null

# MySQL
docker exec -e MYSQL_PWD=rootpassword mysql_plantellectdb sh -c "mysqldump -u root --single-transaction --routines --triggers plantellectdb > /tmp/mysql.sql"
docker cp mysql_plantellectdb:/tmp/mysql.sql "$dir\mysql.sql"

# MongoDB
docker exec mongo_plantellectdb mongodump --uri="mongodb://superadmin:plantpassword@localhost:27017/plantellectmongodb?authSource=admin" --archive=/tmp/mongo.gz --gzip
docker cp mongo_plantellectdb:/tmp/mongo.gz "$dir\mongo.gz"

# Photos + certificates
Compress-Archive administration\botanist\plant-images, administration\botanist\certificates "$dir\files.zip"

# Dataset state (splits.json is the important one; index.sqlite and reports/ are rebuildable)
$state = "config.json","splits.json","groups_manual.csv" |
    ForEach-Object { Join-Path $DatasetIndex $_ } |
    Where-Object { Test-Path $_ }
if ($state) {
    Compress-Archive $state "$dir\dataset-state.zip"
} else {
    Write-Warning "No dataset state files found in $DatasetIndex - skipped."
}

Write-Host "Backup saved to $dir"